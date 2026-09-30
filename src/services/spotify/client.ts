import type { z } from "zod";
import {
  spotifyCurrentlyPlayingSchema,
  spotifyRecentlyPlayedSchema,
  spotifyTokenResponseSchema,
  type SpotifyCurrentlyPlaying,
  type SpotifyRecentlyPlayed,
  type SpotifyTokenResponse,
} from "../../schemas/spotify";
import type { Env } from "../../types/env";

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";
const REQUEST_TIMEOUT_MILLISECONDS = 8_000;

export type SpotifyClientEnv = Pick<Env, "SPOTIFY_CLIENT_ID" | "SPOTIFY_CLIENT_SECRET" | "SPOTIFY_REDIRECT_URI">;

/**
 * A failed Spotify request. Messages carry only the operation and HTTP status; upstream
 * bodies are never read into errors so they cannot leak into responses or logs.
 */
export class SpotifyRequestError extends Error {
  readonly name: string = "SpotifyRequestError";

  constructor(
    readonly operation: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(status === undefined
      ? `Spotify ${operation} request failed`
      : `Spotify ${operation} request failed with status ${status}`);
  }
}

export class SpotifyUnauthorizedError extends SpotifyRequestError {
  readonly name = "SpotifyUnauthorizedError";

  constructor(operation: string) {
    super(operation, 401);
  }
}

export class SpotifyRateLimitedError extends SpotifyRequestError {
  readonly name = "SpotifyRateLimitedError";

  constructor(operation: string, retryAfterSeconds?: number) {
    super(operation, 429, retryAfterSeconds);
  }
}

/** The refresh grant was rejected (e.g. revoked access); re-authorization is required. */
export class SpotifyRefreshRejectedError extends SpotifyRequestError {
  readonly name = "SpotifyRefreshRejectedError";
}

export class SpotifyResponseSchemaError extends Error {
  readonly name = "SpotifyResponseSchemaError";

  constructor(operation: string) {
    super(`Spotify ${operation} response did not match the provider schema`);
  }
}

export const retryAfterSeconds = (response: Response, nowMilliseconds = Date.now()): number | undefined => {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const retryAt = Date.parse(retryAfter);
  if (!Number.isNaN(retryAt)) return Math.max(0, Math.ceil((retryAt - nowMilliseconds) / 1000));
  return undefined;
};

const base64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  return btoa(String.fromCharCode(...bytes));
};

export class SpotifyClient {
  constructor(
    private readonly env: SpotifyClientEnv,
    private readonly accessToken: string,
  ) {}

  async exchangeAuthorizationCode(code: string): Promise<SpotifyTokenResponse & { refresh_token: string }> {
    const tokens = await this.requestToken("token exchange", new URLSearchParams([
      ["grant_type", "authorization_code"],
      ["code", code],
      ["redirect_uri", this.env.SPOTIFY_REDIRECT_URI ?? ""],
    ]));
    if (!tokens.refresh_token) throw new SpotifyResponseSchemaError("token exchange");
    return { ...tokens, refresh_token: tokens.refresh_token };
  }

  async refreshToken(refreshToken: string): Promise<SpotifyTokenResponse> {
    return this.requestToken("token refresh", new URLSearchParams([
      ["grant_type", "refresh_token"],
      ["refresh_token", refreshToken],
    ]));
  }

  /** Returns null when Spotify answers 204 (nothing playing / no active device). */
  async getCurrentlyPlaying(): Promise<SpotifyCurrentlyPlaying | null> {
    const response = await this.request("currently playing", `${SPOTIFY_API_BASE_URL}/me/player/currently-playing`, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    });
    if (response.status === 204) return null;
    return this.parse("currently playing", spotifyCurrentlyPlayingSchema, await this.json("currently playing", response));
  }

  async getRecentlyPlayed(): Promise<SpotifyRecentlyPlayed> {
    const response = await this.request("recently played", `${SPOTIFY_API_BASE_URL}/me/player/recently-played?limit=1`, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    });
    if (response.status === 204) return { items: [] };
    return this.parse("recently played", spotifyRecentlyPlayedSchema, await this.json("recently played", response));
  }

  private async requestToken(operation: string, body: URLSearchParams): Promise<SpotifyTokenResponse> {
    let response: Response;
    try {
      response = await this.request(operation, SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: {
          authorization: `Basic ${base64(`${this.env.SPOTIFY_CLIENT_ID ?? ""}:${this.env.SPOTIFY_CLIENT_SECRET ?? ""}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (error) {
      // 400 invalid_grant (revoked/expired refresh token) and 401 invalid_client are definite.
      if (operation === "token refresh"
        && error instanceof SpotifyRequestError
        && (error.status === 400 || error.status === 401)) {
        throw new SpotifyRefreshRejectedError(operation, error.status);
      }
      throw error;
    }
    return this.parse(operation, spotifyTokenResponseSchema, await this.json(operation, response));
  }

  private async request(operation: string, url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS) });
    } catch {
      throw new SpotifyRequestError(operation);
    }
    if (response.ok) return response;
    // Discard the body so upstream error details are never surfaced.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new SpotifyUnauthorizedError(operation);
    if (response.status === 429) throw new SpotifyRateLimitedError(operation, retryAfterSeconds(response));
    throw new SpotifyRequestError(operation, response.status);
  }

  private async json(operation: string, response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new SpotifyResponseSchemaError(operation);
    }
  }

  private parse<T>(operation: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, payload: unknown): T {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new SpotifyResponseSchemaError(operation);
    return parsed.data;
  }
}
