import type { Env } from "../../types/env";
import type { SpotifyRecentlyPlayed, SpotifyTokenResponse } from "../../schemas/spotify";
import { SpotifyClient, SpotifyUnauthorizedError } from "./client";
import { SpotifyRepository } from "./repository";

// Spotify keeps only your last 50 plays. This copies them into music_plays so
// the history grows forever. Safe to repeat: (played_at, track_id) is unique.

export interface HistoryClient {
  refreshToken(refreshToken: string): Promise<SpotifyTokenResponse>;
  getRecentlyPlayed(limit?: number): Promise<SpotifyRecentlyPlayed>;
}

export interface Play {
  played_at: string; track_id: string; track: string; artists: string | null;
  album: string | null; image_url: string | null; duration_ms: number | null; url: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const text = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Turns Spotify's recently-played items into rows. Episodes and odd items are skipped. */
export function playsFrom(recent: SpotifyRecentlyPlayed): Play[] {
  return recent.items.flatMap((item) => {
    const track = obj(item.track);
    const id = text(track.id), name = text(track.name);
    if (!id || !name || Number.isNaN(Date.parse(item.played_at))) return [];
    const album = obj(track.album);
    const images = Array.isArray(album.images) ? (album.images as unknown[]).map(obj) : [];
    const artists = Array.isArray(track.artists) ? (track.artists as unknown[]).map((a) => text(obj(a).name)).filter(Boolean) : [];
    return [{
      played_at: new Date(item.played_at).toISOString(), track_id: id, track: name,
      artists: artists.length ? artists.join(", ") : null, album: text(album.name),
      image_url: text(images[0]?.url), duration_ms: typeof track.duration_ms === "number" ? track.duration_ms : null,
      url: text(obj(track.external_urls).spotify),
    }];
  });
}

export async function savePlays(db: D1Database, plays: Play[], now = new Date().toISOString()) {
  if (plays.length === 0) return 0;
  const results = await db.batch(plays.map((p) => db.prepare(
    `INSERT OR IGNORE INTO music_plays (played_at, track_id, track, artists, album, image_url, duration_ms, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(p.played_at, p.track_id, p.track, p.artists, p.album, p.image_url, p.duration_ms, p.url, now)));
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
}

/** Copies the last 50 plays. Returns how many were new, or null when Spotify isn't connected. */
export async function syncMusicPlays(
  env: Env,
  deps: { repository?: SpotifyRepository; clientFactory?: (token: string) => HistoryClient; now?: () => Date } = {},
): Promise<number | null> {
  const now = deps.now ?? (() => new Date());
  const repository = deps.repository ?? new SpotifyRepository(env.DB, env.WHOOP_TOKEN_ENCRYPTION_KEY);
  const clientFor = deps.clientFactory ?? ((token: string) => new SpotifyClient(env, token));
  const connection = await repository.getConnection();
  if (!connection || connection.status !== "active" || !connection.hasTokens) return null;
  const version = connection.credentialVersion;

  const refreshed = async () => {
    const refreshToken = await repository.getRefreshToken(version);
    if (refreshToken === null) throw new Error("Spotify refresh token is unavailable");
    const tokens = await clientFor("").refreshToken(refreshToken);
    const at = now();
    await repository.storeRefreshedTokens(version, {
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(at.getTime() + tokens.expires_in * 1000).toISOString(),
      refreshToken: tokens.refresh_token,
      grantedScopes: tokens.scope?.split(/\s+/).filter(Boolean),
      refreshedAt: at.toISOString(),
    });
    return tokens.access_token;
  };

  const expiresAt = Date.parse(connection.accessTokenExpiresAt ?? "");
  const fresh = Number.isFinite(expiresAt) && expiresAt > now().getTime() + 60_000;
  let token = fresh ? await repository.getAccessToken(version) : null;
  let recent: SpotifyRecentlyPlayed;
  try {
    recent = await clientFor(token ?? (token = await refreshed())).getRecentlyPlayed(50);
  } catch (error) {
    if (!(error instanceof SpotifyUnauthorizedError)) throw error;
    recent = await clientFor(await refreshed()).getRecentlyPlayed(50);
  }
  return savePlays(env.DB, playsFrom(recent), now().toISOString());
}
