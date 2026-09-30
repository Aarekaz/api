import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import { requireAuth } from "../../middleware/auth";
import { createMusicRoute } from "../../routes/music";
import { musicNowResponseSchema } from "../../schemas/openapi";
import { SpotifyRepository } from "../../services/spotify/repository";
import type { Env } from "../../types/env";
import {
  CURRENTLY_PLAYING,
  ENV,
  KEY,
  NOW,
  PODCAST_PLAYING,
  RECENTLY_PLAYED,
  RECENT_TRACK_ID,
  TRACK,
  TRACK_ID,
  bearer,
  connectionRow,
  createSpotifyDatabase,
  jsonResponse,
  stubSpotifyFetch,
  type SqliteDatabase,
} from "./fixtures";

const ACCESS_TOKEN = "stored-access-token";
const REFRESH_TOKEN = "stored-refresh-token";
const PLAYING_BODY = {
  state: "playing",
  track: {
    title: "Never Gonna Give You Up",
    artists: ["Rick Astley", "Guest"],
    album: "Whenever You Need Somebody",
    image_url: "https://i.scdn.co/image/64",
    url: `https://open.spotify.com/track/${TRACK_ID}`,
    duration_ms: 213573,
    progress_ms: 42000,
    played_at: null,
  },
  fetched_at: NOW,
};
const RECENT_BODY = {
  state: "recent",
  track: {
    title: "Recent Song",
    artists: ["Recent Artist"],
    album: "Recent Album",
    image_url: "https://i.scdn.co/image/r300",
    url: `https://open.spotify.com/track/${RECENT_TRACK_ID}`,
    duration_ms: 213573,
    progress_ms: null,
    played_at: "2026-09-30T11:40:00.123Z",
  },
  fetched_at: NOW,
};

let sqlite: SqliteDatabase;
let env: Env;
let repository: SpotifyRepository;
let currentTime: Date;

const app = () => {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use("/v1/*", requireAuth);
  hono.route("/v1/music", createMusicRoute({ now: () => currentTime }));
  return hono;
};

const getNow = async () => {
  const response = await app().request("/v1/music/now", bearer(), env);
  expect(response.status).toBe(200);
  const text = await response.text();
  return { body: JSON.parse(text) as Record<string, unknown>, text };
};

const connect = async (accessTokenExpiresAt = "2026-09-30T13:00:00.000Z") => {
  await repository.saveConnection({
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt,
    refreshToken: REFRESH_TOKEN,
    grantedScopes: ["user-read-currently-playing", "user-read-recently-played"],
    connectedAt: "2026-09-30T10:00:00.000Z",
  });
};

const advance = (milliseconds: number) => {
  currentTime = new Date(currentTime.getTime() + milliseconds);
};

const bearerOf = (request: Request) => request.headers.get("authorization");

beforeEach(async () => {
  const database = await createSpotifyDatabase();
  sqlite = database.sqlite;
  env = { ...ENV, DB: database.db };
  repository = new SpotifyRepository(env.DB, KEY);
  currentTime = new Date(NOW);
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});

describe("GET /v1/music/now", () => {
  it("requires the API bearer token on the worker", async () => {
    const response = await worker.fetch(new Request("https://api.example.test/v1/music/now"), env);
    expect(response.status).toBe(401);
  });

  it("returns disconnected (200) without calling Spotify when no credentials are stored", async () => {
    const { fetchMock } = stubSpotifyFetch({});

    const { body } = await getNow();

    expect(body).toEqual({ state: "disconnected", track: null, fetched_at: NOW });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns disconnected after the owner disconnects", async () => {
    await connect();
    await repository.disconnect(1, NOW);
    const { fetchMock } = stubSpotifyFetch({});

    expect((await getNow()).body.state).toBe("disconnected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a playing track with the smallest https image >= 64px and a canonical track URL", async () => {
    await connect();
    const { callsTo } = stubSpotifyFetch({ currentlyPlaying: () => jsonResponse(CURRENTLY_PLAYING) });

    const { body } = await getNow();

    expect(body).toEqual(PLAYING_BODY);
    expect(musicNowResponseSchema.parse(body)).toEqual(body);
    expect(bearerOf(callsTo("/v1/me/player/currently-playing")[0])).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(callsTo("/v1/me/player/recently-played")).toHaveLength(0);
  });

  it("falls through a playing podcast to the most recent track", async () => {
    await connect();
    const { callsTo } = stubSpotifyFetch({
      currentlyPlaying: () => jsonResponse(PODCAST_PLAYING),
      recentlyPlayed: () => jsonResponse(RECENTLY_PLAYED),
    });

    const { body } = await getNow();

    expect(body).toEqual(RECENT_BODY);
    expect(new URL(callsTo("/v1/me/player/recently-played")[0].url).searchParams.get("limit")).toBe("1");
  });

  it("falls through paused playback and ads to recent", async () => {
    await connect();
    stubSpotifyFetch({
      currentlyPlaying: () => jsonResponse({ ...CURRENTLY_PLAYING, is_playing: false }),
      recentlyPlayed: () => jsonResponse(RECENTLY_PLAYED),
    });
    expect((await getNow()).body.state).toBe("recent");

    advance(30_000);
    stubSpotifyFetch({
      currentlyPlaying: () => jsonResponse({ is_playing: true, currently_playing_type: "ad", item: null }),
      recentlyPlayed: () => jsonResponse(RECENTLY_PLAYED),
    });
    expect((await getNow()).body.state).toBe("recent");
  });

  it("treats Spotify 204 (nothing playing) as a fall-through to recent", async () => {
    await connect();
    stubSpotifyFetch({
      currentlyPlaying: () => new Response(null, { status: 204 }),
      recentlyPlayed: () => jsonResponse(RECENTLY_PLAYED),
    });

    expect((await getNow()).body).toEqual(RECENT_BODY);
  });

  it("returns idle when connected but nothing is playing or recent", async () => {
    await connect();
    stubSpotifyFetch({
      currentlyPlaying: () => new Response(null, { status: 204 }),
      recentlyPlayed: () => jsonResponse({ items: [] }),
    });

    expect((await getNow()).body).toEqual({ state: "idle", track: null, fetched_at: NOW });
  });

  it("ignores local files without a Spotify track ID", async () => {
    await connect();
    stubSpotifyFetch({
      currentlyPlaying: () => jsonResponse({ ...CURRENTLY_PLAYING, item: { ...TRACK, id: null, is_local: true } }),
      recentlyPlayed: () => jsonResponse({ items: [] }),
    });

    expect((await getNow()).body.state).toBe("idle");
  });

  it("returns a null image when no https image is at least 64px", async () => {
    await connect();
    stubSpotifyFetch({
      currentlyPlaying: () => jsonResponse({
        ...CURRENTLY_PLAYING,
        item: { ...TRACK, album: { name: null, images: [{ url: "https://i.scdn.co/image/32", width: 32, height: 32 }] } },
      }),
    });

    const track = (await getNow()).body.track as Record<string, unknown>;
    expect(track.image_url).toBeNull();
    expect(track.album).toBeNull();
  });

  it("serves the cached result for ~25s, then fetches again", async () => {
    await connect();
    const { fetchMock } = stubSpotifyFetch({ currentlyPlaying: () => jsonResponse(CURRENTLY_PLAYING) });

    await getNow();
    advance(20_000);
    const cached = await getNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached.body).toEqual(PLAYING_BODY);

    advance(10_000);
    const fresh = await getNow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fresh.body.fetched_at).toBe("2026-09-30T12:00:30.000Z");
  });

  it("refreshes once on 401, retries, and persists a rotated refresh token", async () => {
    await connect();
    let currentlyPlayingCalls = 0;
    const { callsTo } = stubSpotifyFetch({
      currentlyPlaying: (request) => {
        currentlyPlayingCalls += 1;
        return bearerOf(request) === "Bearer refreshed-access-token"
          ? jsonResponse(CURRENTLY_PLAYING)
          : jsonResponse({ error: { status: 401, message: "The access token expired" } }, { status: 401 });
      },
      token: () => jsonResponse({
        access_token: "refreshed-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rotated-refresh-token",
        scope: "user-read-currently-playing user-read-recently-played",
      }),
    });

    const { body } = await getNow();

    expect(body).toEqual(PLAYING_BODY);
    expect(currentlyPlayingCalls).toBe(2);
    const [tokenRequest] = callsTo("/api/token");
    expect(Object.fromEntries(new URLSearchParams(await tokenRequest.text()))).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
    });
    expect(tokenRequest.headers.get("authorization"))
      .toBe(`Basic ${btoa("test-spotify-client-id:test-spotify-client-secret")}`);
    await expect(repository.getAccessToken(1)).resolves.toBe("refreshed-access-token");
    await expect(repository.getRefreshToken(1)).resolves.toBe("rotated-refresh-token");
    const row = connectionRow(sqlite)!;
    expect(row.access_token_expires_at).toBe("2026-09-30T13:00:00.000Z");
    expect(JSON.stringify(row)).not.toMatch(/refreshed-access-token|rotated-refresh-token/);
  });

  it("keeps the existing refresh token when Spotify does not rotate it", async () => {
    await connect("2026-09-30T12:00:30.000Z"); // expires within the refresh margin
    const { callsTo } = stubSpotifyFetch({
      token: () => jsonResponse({ access_token: "refreshed-access-token", token_type: "Bearer", expires_in: 3600 }),
      currentlyPlaying: () => jsonResponse(CURRENTLY_PLAYING),
    });

    expect((await getNow()).body.state).toBe("playing");
    expect(bearerOf(callsTo("/v1/me/player/currently-playing")[0])).toBe("Bearer refreshed-access-token");
    await expect(repository.getRefreshToken(1)).resolves.toBe(REFRESH_TOKEN);
  });

  it("does not loop when the refreshed token is also rejected", async () => {
    await connect();
    const { callsTo } = stubSpotifyFetch({
      currentlyPlaying: () => new Response(null, { status: 401 }),
      token: () => jsonResponse({ access_token: "refreshed-access-token", token_type: "Bearer", expires_in: 3600 }),
    });

    expect((await getNow()).body).toEqual({ state: "idle", track: null, fetched_at: NOW });
    expect(callsTo("/api/token")).toHaveLength(1);
    expect(callsTo("/v1/me/player/currently-playing")).toHaveLength(2);
  });

  it("marks the grant as needing re-authorization when the refresh token is revoked", async () => {
    await connect();
    stubSpotifyFetch({
      currentlyPlaying: () => new Response(null, { status: 401 }),
      token: () => jsonResponse({ error: "invalid_grant", error_description: "Refresh token revoked" }, { status: 400 }),
    });

    const { body, text } = await getNow();

    expect(body).toEqual({ state: "disconnected", track: null, fetched_at: NOW });
    expect(text).not.toContain("invalid_grant");
    expect(connectionRow(sqlite)).toMatchObject({
      status: "needs_reauth",
      refresh_token_ciphertext: null,
      access_token_ciphertext: null,
    });
  });

  it("serves the last cached value on 429 and honors Retry-After before calling Spotify again", async () => {
    await connect();
    const first = stubSpotifyFetch({ currentlyPlaying: () => jsonResponse(CURRENTLY_PLAYING) });
    await getNow();
    expect(first.fetchMock).toHaveBeenCalledTimes(1);

    advance(30_000);
    const limited = stubSpotifyFetch({
      currentlyPlaying: () => jsonResponse({ error: { status: 429, message: "upstream-rate-detail" } }, {
        status: 429,
        headers: { "retry-after": "120" },
      }),
    });
    const during = await getNow();
    expect(during.body).toEqual(PLAYING_BODY);
    expect(during.text).not.toContain("upstream-rate-detail");
    expect(connectionRow(sqlite)!.rate_limited_until).toBe("2026-09-30T12:02:30.000Z");

    advance(60_000);
    expect((await getNow()).body).toEqual(PLAYING_BODY);
    expect(limited.fetchMock).toHaveBeenCalledTimes(1);

    advance(61_000);
    const after = stubSpotifyFetch({
      currentlyPlaying: () => new Response(null, { status: 204 }),
      recentlyPlayed: () => jsonResponse(RECENTLY_PLAYED),
    });
    expect((await getNow()).body.state).toBe("recent");
    expect(after.fetchMock).toHaveBeenCalledTimes(2);
    expect(connectionRow(sqlite)!.rate_limited_until).toBeNull();
  });

  it("returns idle on 429 when nothing has been cached yet", async () => {
    await connect();
    stubSpotifyFetch({ currentlyPlaying: () => new Response("slow down", { status: 429 }) });

    expect((await getNow()).body).toEqual({ state: "idle", track: null, fetched_at: NOW });
    // Missing Retry-After falls back to a 30 second back-off.
    expect(connectionRow(sqlite)!.rate_limited_until).toBe("2026-09-30T12:00:30.000Z");
  });

  it("serves the last cached value on network failure, else idle", async () => {
    await connect();
    stubSpotifyFetch({ currentlyPlaying: () => { throw new TypeError("network down"); } });
    expect((await getNow()).body).toEqual({ state: "idle", track: null, fetched_at: NOW });

    advance(1_000);
    stubSpotifyFetch({ currentlyPlaying: () => jsonResponse(CURRENTLY_PLAYING) });
    const cachedAt = currentTime.toISOString();
    await getNow();

    advance(40_000);
    stubSpotifyFetch({
      currentlyPlaying: () => { throw new TypeError("network down"); },
    });
    const { body } = await getNow();
    expect(body).toEqual({ ...PLAYING_BODY, fetched_at: cachedAt });
  });

  it("falls back to cache on upstream 5xx and malformed payloads without leaking them", async () => {
    await connect();
    stubSpotifyFetch({ currentlyPlaying: () => jsonResponse(CURRENTLY_PLAYING) });
    await getNow();

    advance(30_000);
    stubSpotifyFetch({ currentlyPlaying: () => new Response("<html>upstream-500-detail</html>", { status: 503 }) });
    const serverError = await getNow();
    expect(serverError.body).toEqual(PLAYING_BODY);
    expect(serverError.text).not.toContain("upstream-500-detail");

    advance(30_000);
    stubSpotifyFetch({ currentlyPlaying: () => jsonResponse({ unexpected: "upstream-shape-detail" }) });
    const malformed = await getNow();
    expect(malformed.body).toEqual(PLAYING_BODY);
    expect(malformed.text).not.toContain("upstream-shape-detail");
  });

  it("never includes tokens or unprojected upstream fields in the response", async () => {
    await connect();
    stubSpotifyFetch({ currentlyPlaying: () => jsonResponse(CURRENTLY_PLAYING) });

    const { body, text } = await getNow();

    expect(Object.keys(body)).toEqual(["state", "track", "fetched_at"]);
    expect(Object.keys(body.track as object).sort()).toEqual([
      "album", "artists", "duration_ms", "image_url", "played_at", "progress_ms", "title", "url",
    ]);
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, "secret-device-name", "available_markets", "external_urls"]) {
      expect(text).not.toContain(secret);
    }
  });
});
