import {
  musicNowResponseSchema,
  type MusicNowResponse,
  type MusicNowTrack,
} from "../../schemas/openapi";
import { spotifyTrackSchema, type SpotifyCurrentlyPlaying, type SpotifyRecentlyPlayed, type SpotifyTokenResponse } from "../../schemas/spotify";
import type { Env } from "../../types/env";
import {
  SpotifyClient,
  SpotifyRateLimitedError,
  SpotifyRefreshRejectedError,
  SpotifyUnauthorizedError,
} from "./client";
import { SpotifyRepository, type SpotifyConnection } from "./repository";

/** How long a successful result is served from D1 before Spotify is asked again. */
export const MUSIC_NOW_CACHE_MILLISECONDS = 25_000;
const DEFAULT_RATE_LIMIT_SECONDS = 30;
const MAX_RATE_LIMIT_SECONDS = 60 * 60;
/** Refresh proactively when the stored access token expires within this window. */
const ACCESS_TOKEN_REFRESH_MARGIN_MILLISECONDS = 60_000;
const MIN_IMAGE_SIZE = 64;
const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]+$/;

export interface MusicRepository {
  getConnection(): Promise<SpotifyConnection | null>;
  getAccessToken(credentialVersion: number): Promise<string | null>;
  getRefreshToken(credentialVersion: number): Promise<string | null>;
  storeRefreshedTokens(
    ...input: Parameters<SpotifyRepository["storeRefreshedTokens"]>
  ): Promise<boolean>;
  markNeedsReauth(credentialVersion: number, updatedAt: string): Promise<boolean>;
  storeNowCache(credentialVersion: number, nowJson: string, fetchedAt: string): Promise<boolean>;
  setRateLimitedUntil(credentialVersion: number, rateLimitedUntil: string): Promise<boolean>;
}

export interface MusicClient {
  refreshToken(refreshToken: string): Promise<SpotifyTokenResponse>;
  getCurrentlyPlaying(): Promise<SpotifyCurrentlyPlaying | null>;
  getRecentlyPlayed(): Promise<SpotifyRecentlyPlayed>;
}

export interface MusicNowDependencies {
  repository?: MusicRepository;
  clientFactory?: (env: Env, accessToken: string) => MusicClient;
  now?: () => Date;
}

const emptyResult = (state: "idle" | "disconnected", now: Date): MusicNowResponse => ({
  state,
  track: null,
  fetched_at: now.toISOString(),
});

const smallestImage = (images: Array<{ url: string; width?: number | null; height?: number | null }> = []): string | null => {
  let best: { url: string; size: number } | null = null;
  for (const image of images) {
    if (!image.url.startsWith("https://")) continue;
    const size = image.width ?? image.height;
    if (typeof size !== "number" || !Number.isFinite(size) || size < MIN_IMAGE_SIZE) continue;
    if (best === null || size < best.size) best = { url: image.url, size };
  }
  return best?.url ?? null;
};

const nonNegativeInteger = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

const isoTimestamp = (value: string): string | null => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/**
 * Projects an upstream track into the public shape. Returns null for anything that is not
 * a linkable Spotify track (episodes, ads, local files without an ID, malformed items).
 */
export const toMusicTrack = (
  raw: unknown,
  timing: { progressMs?: number | null; playedAt?: string | null },
): MusicNowTrack | null => {
  const parsed = spotifyTrackSchema.safeParse(raw);
  if (!parsed.success) return null;
  const track = parsed.data;
  if (track.id === null || !SPOTIFY_ID_PATTERN.test(track.id)) return null;
  return {
    title: track.name,
    artists: track.artists.map((artist) => artist.name),
    album: track.album?.name ?? null,
    image_url: smallestImage(track.album?.images),
    url: `https://open.spotify.com/track/${track.id}`,
    duration_ms: nonNegativeInteger(track.duration_ms),
    progress_ms: nonNegativeInteger(timing.progressMs),
    played_at: timing.playedAt ?? null,
  };
};

export const readMusicNow = async (client: MusicClient, fetchedAt: Date): Promise<MusicNowResponse> => {
  const current = await client.getCurrentlyPlaying();
  if (current && current.is_playing && current.currently_playing_type === "track") {
    const track = toMusicTrack(current.item, { progressMs: current.progress_ms ?? null });
    if (track) return { state: "playing", track, fetched_at: fetchedAt.toISOString() };
  }
  const recent = await client.getRecentlyPlayed();
  const item = recent.items[0];
  if (item) {
    const playedAt = isoTimestamp(item.played_at);
    const track = playedAt === null ? null : toMusicTrack(item.track, { playedAt });
    if (track) return { state: "recent", track, fetched_at: fetchedAt.toISOString() };
  }
  return emptyResult("idle", fetchedAt);
};

const parseCached = (connection: SpotifyConnection): MusicNowResponse | null => {
  if (connection.nowJson === null) return null;
  try {
    const parsed = musicNowResponseSchema.safeParse(JSON.parse(connection.nowJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const timestampMilliseconds = (value: string | null): number => (value === null ? Number.NaN : Date.parse(value));

const ignoreFailure = async (operation: () => Promise<unknown>): Promise<void> => {
  try {
    await operation();
  } catch {
    // Cache bookkeeping must never turn a servable result into an error.
  }
};

export async function getMusicNow(env: Env, dependencies: MusicNowDependencies = {}): Promise<MusicNowResponse> {
  const now = dependencies.now ?? (() => new Date());
  const repository = dependencies.repository
    ?? new SpotifyRepository(env.DB, env.WHOOP_TOKEN_ENCRYPTION_KEY);
  const clientFor = (accessToken: string): MusicClient => dependencies.clientFactory?.(env, accessToken)
    ?? new SpotifyClient(env, accessToken);

  const requestedAt = now();
  const connection = await repository.getConnection();
  if (!connection || connection.status !== "active" || !connection.hasTokens) {
    return emptyResult("disconnected", requestedAt);
  }
  const credentialVersion = connection.credentialVersion;
  const cached = parseCached(connection);
  const cachedAge = requestedAt.getTime() - timestampMilliseconds(connection.nowFetchedAt);
  if (cached && cachedAge >= 0 && cachedAge < MUSIC_NOW_CACHE_MILLISECONDS) return cached;
  if (timestampMilliseconds(connection.rateLimitedUntil) > requestedAt.getTime()) {
    return cached ?? emptyResult("idle", requestedAt);
  }

  const refreshAccessToken = async (): Promise<string> => {
    const refreshToken = await repository.getRefreshToken(credentialVersion);
    if (refreshToken === null) throw new Error("Spotify refresh token is unavailable");
    const tokens = await clientFor("").refreshToken(refreshToken);
    const refreshedAt = now();
    const stored = await repository.storeRefreshedTokens(credentialVersion, {
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(refreshedAt.getTime() + tokens.expires_in * 1000).toISOString(),
      refreshToken: tokens.refresh_token,
      grantedScopes: tokens.scope?.split(/\s+/).filter(Boolean),
      refreshedAt: refreshedAt.toISOString(),
    });
    if (!stored) throw new Error("Spotify connection changed during token refresh");
    return tokens.access_token;
  };

  const withAccessToken = async <T>(request: (client: MusicClient) => Promise<T>): Promise<T> => {
    const expiresAt = timestampMilliseconds(connection.accessTokenExpiresAt);
    const expiresSoon = !Number.isFinite(expiresAt)
      || expiresAt <= requestedAt.getTime() + ACCESS_TOKEN_REFRESH_MARGIN_MILLISECONDS;
    const storedAccessToken = expiresSoon ? null : await repository.getAccessToken(credentialVersion);
    if (storedAccessToken !== null) {
      try {
        return await request(clientFor(storedAccessToken));
      } catch (error) {
        if (!(error instanceof SpotifyUnauthorizedError)) throw error;
      }
    }
    // Refresh at most once per request; a second 401 falls back to the cached value.
    return request(clientFor(await refreshAccessToken()));
  };

  try {
    const result = await withAccessToken((client) => readMusicNow(client, requestedAt));
    await ignoreFailure(() => repository.storeNowCache(credentialVersion, JSON.stringify(result), result.fetched_at));
    return result;
  } catch (error) {
    if (error instanceof SpotifyRefreshRejectedError) {
      await ignoreFailure(() => repository.markNeedsReauth(credentialVersion, now().toISOString()));
      return emptyResult("disconnected", requestedAt);
    }
    if (error instanceof SpotifyRateLimitedError) {
      const seconds = Math.min(
        MAX_RATE_LIMIT_SECONDS,
        Math.max(1, error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS),
      );
      await ignoreFailure(() => repository.setRateLimitedUntil(
        credentialVersion,
        new Date(requestedAt.getTime() + seconds * 1000).toISOString(),
      ));
    }
    return cached ?? emptyResult("idle", requestedAt);
  }
}
