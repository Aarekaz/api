import { vi } from "vitest";
import type { Env } from "../../types/env";
import { ENV as WHOOP_ENV, KEY } from "../whoop/fixtures";

export { KEY };
export const NOW = "2026-09-30T12:00:00.000Z";
export const TRACK_ID = "4uLU6hMCjMI75M1A2tKUQC";
export const RECENT_TRACK_ID = "7GhIk7Il098yCjg4BQjzvb";

export const ENV: Env = {
  ...WHOOP_ENV,
  SPOTIFY_CLIENT_ID: "test-spotify-client-id",
  SPOTIFY_CLIENT_SECRET: "test-spotify-client-secret",
  SPOTIFY_REDIRECT_URI: "https://api.example.test/integrations/spotify/callback",
};

export const bearer = (method = "GET") => ({ method, headers: { Authorization: "Bearer test-api-token" } });

export const jsonResponse = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
  ...init,
});

export const TRACK = {
  id: TRACK_ID,
  name: "Never Gonna Give You Up",
  type: "track",
  duration_ms: 213573,
  artists: [{ name: "Rick Astley", id: "a1" }, { name: "Guest", id: "a2" }],
  album: {
    name: "Whenever You Need Somebody",
    images: [
      { url: "https://i.scdn.co/image/640", width: 640, height: 640 },
      { url: "https://i.scdn.co/image/300", width: 300, height: 300 },
      { url: "https://i.scdn.co/image/64", width: 64, height: 64 },
      { url: "https://i.scdn.co/image/32", width: 32, height: 32 },
      { url: "http://i.scdn.co/image/insecure", width: 100, height: 100 },
    ],
  },
  external_urls: { spotify: `https://open.spotify.com/track/${TRACK_ID}` },
  available_markets: ["US"],
};

export const RECENT_TRACK = {
  ...TRACK,
  id: RECENT_TRACK_ID,
  name: "Recent Song",
  artists: [{ name: "Recent Artist" }],
  album: { name: "Recent Album", images: [{ url: "https://i.scdn.co/image/r300", width: 300, height: 300 }] },
};

export const CURRENTLY_PLAYING = {
  is_playing: true,
  progress_ms: 42000,
  currently_playing_type: "track",
  item: TRACK,
  device: { name: "secret-device-name" },
};

export const PODCAST_PLAYING = {
  is_playing: true,
  progress_ms: 1000,
  currently_playing_type: "episode",
  item: null,
};

export const EPISODE_ID = "5Xt5DXGzch68nYYamXrNxZ";

export const EPISODE_PLAYING = {
  is_playing: true,
  progress_ms: 1000,
  currently_playing_type: "episode",
  item: {
    id: EPISODE_ID,
    type: "episode",
    name: "Episode 412: Transit Maps",
    duration_ms: 3600000,
    images: [
      { url: "https://i.scdn.co/image/ep640", width: 640, height: 640 },
      { url: "https://i.scdn.co/image/ep64", width: 64, height: 64 },
    ],
    show: {
      name: "The Commute Show",
      images: [{ url: "https://i.scdn.co/image/show64", width: 64, height: 64 }],
    },
  },
};

export const RECENTLY_PLAYED = {
  items: [{ track: RECENT_TRACK, played_at: "2026-09-30T11:40:00.123Z", context: null }],
  cursors: { after: "1", before: "0" },
};

export type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * Stubs global fetch with per-endpoint handlers. Any unexpected URL fails the test, so no
 * request can ever reach the real Spotify API.
 */
export function stubSpotifyFetch(handlers: {
  token?: FetchHandler;
  currentlyPlaying?: FetchHandler;
  recentlyPlayed?: FetchHandler;
}) {
  const calls: Request[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    const url = new URL(request.url);
    const key = url.origin === "https://accounts.spotify.com" && url.pathname === "/api/token"
      ? "token"
      : url.origin === "https://api.spotify.com" && url.pathname === "/v1/me/player/currently-playing"
        ? "currentlyPlaying"
        : url.origin === "https://api.spotify.com" && url.pathname === "/v1/me/player/recently-played"
          ? "recentlyPlayed"
          : null;
    const handler = key ? handlers[key] : undefined;
    if (!handler) throw new Error(`Unexpected fetch in test: ${request.method} ${request.url}`);
    return handler(request);
  });
  vi.stubGlobal("fetch", fetchMock);
  const callsTo = (path: string) => calls.filter((request) => new URL(request.url).pathname === path);
  return { fetchMock, calls, callsTo };
}

// Minimal node:sqlite-backed D1 shim so repository SQL runs against the real migration.
type SqliteStatement = {
  all: (...bindings: unknown[]) => unknown[];
  get: (...bindings: unknown[]) => unknown;
  run: (...bindings: unknown[]) => { changes: number | bigint };
};

export type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

class SqliteD1Statement {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, bindings);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null;
  }

  async all<T>() {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[], success: true, meta: {} };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

export async function createSpotifyDatabase(): Promise<{ db: D1Database; sqlite: SqliteDatabase }> {
  // @ts-expect-error Node test-runtime types are intentionally excluded from the Worker build.
  const { DatabaseSync } = await import("node:sqlite");
  // @ts-expect-error Node test-runtime types are intentionally excluded from the Worker build.
  const { readFile } = await import("node:fs/promises");
  const sqlite = new DatabaseSync(":memory:") as SqliteDatabase;
  sqlite.exec(await readFile("migrations/0023_spotify.sql", "utf8"));
  const db = { prepare: (sql: string) => new SqliteD1Statement(sqlite, sql) } as unknown as D1Database;
  return { db, sqlite };
}

export type ConnectionRow = {
  status: string;
  credential_version: number;
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_expires_at: string | null;
  refresh_token_ciphertext: string | null;
  refresh_token_nonce: string | null;
  granted_scopes: string;
  now_json: string | null;
  now_fetched_at: string | null;
  rate_limited_until: string | null;
};

export const connectionRow = (sqlite: SqliteDatabase) =>
  sqlite.prepare("SELECT * FROM spotify_connections WHERE id = 1").get() as ConnectionRow | undefined;
