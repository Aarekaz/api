import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import { requireAuth } from "../../middleware/auth";
import { createSpotifyIntegrationRoute } from "../../routes/spotify-integration";
import { hashOAuthState } from "../../services/oauth-crypto";
import { SpotifyRepository } from "../../services/spotify/repository";
import type { Env } from "../../types/env";
import {
  ENV,
  KEY,
  NOW,
  bearer,
  connectionRow,
  createSpotifyDatabase,
  jsonResponse,
  stubSpotifyFetch,
  type SqliteDatabase,
} from "./fixtures";

const CONNECTED_REDIRECT = "https://os.example.test/music/source?result=connected";
const FAILED_REDIRECT = "https://os.example.test/music/source?result=failed";
const TOKEN_RESPONSE = {
  access_token: "fixture-spotify-access-token",
  token_type: "Bearer",
  scope: "user-read-currently-playing user-read-recently-played",
  expires_in: 3600,
  refresh_token: "fixture-spotify-refresh-token",
};

let sqlite: SqliteDatabase;
let env: Env;
let currentTime: Date;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/v1/*", requireAuth);
  app.route("/", createSpotifyIntegrationRoute({ now: () => currentTime }));
  return app;
}

async function startConnect(app = createApp()): Promise<string> {
  const response = await app.request("/v1/integrations/spotify/connect", bearer("POST"), env);
  expect(response.status).toBe(200);
  const body = await response.json() as { authorization_url: string };
  return new URL(body.authorization_url).searchParams.get("state")!;
}

beforeEach(async () => {
  const database = await createSpotifyDatabase();
  sqlite = database.sqlite;
  env = { ...ENV, DB: database.db };
  currentTime = new Date(NOW);
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Spotify integration routes", () => {
  it("mounts management routes behind the worker bearer middleware and leaves the callback public", async () => {
    const connect = await worker.fetch(new Request("https://api.example.test/v1/integrations/spotify/connect", {
      method: "POST",
    }), env);
    const status = await worker.fetch(new Request("https://api.example.test/v1/integrations/spotify"), env);
    const disconnect = await worker.fetch(new Request("https://api.example.test/v1/integrations/spotify", {
      method: "DELETE",
    }), env);
    const callback = await worker.fetch(new Request("https://api.example.test/integrations/spotify/callback"), env);

    expect(connect.status).toBe(401);
    expect(status.status).toBe(401);
    expect(disconnect.status).toBe(401);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(FAILED_REDIRECT);
  });

  it("returns an authorization URL with the fixed redirect, scopes, and a stored hashed one-use state", async () => {
    const app = createApp();
    const unauthorized = await app.request("/v1/integrations/spotify/connect", { method: "POST" }, env);
    const response = await app.request("/v1/integrations/spotify/connect", bearer("POST"), env);
    const body = await response.json() as Record<string, string>;
    const url = new URL(body.authorization_url);
    const state = url.searchParams.get("state")!;

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual(["authorization_url"]);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-spotify-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(ENV.SPOTIFY_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("user-read-currently-playing user-read-recently-played");
    expect(state).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(body.authorization_url).not.toContain("test-spotify-client-secret");

    const stored = sqlite.prepare("SELECT * FROM spotify_oauth_states").all() as Array<Record<string, string | null>>;
    expect(stored).toEqual([{
      state_hash: await hashOAuthState(state),
      created_at: NOW,
      expires_at: "2026-09-30T12:10:00.000Z",
      consumed_at: null,
    }]);
    expect(JSON.stringify(stored)).not.toContain(state);
  });

  it.each([
    ["client secret", { SPOTIFY_CLIENT_SECRET: "" }],
    ["client id", { SPOTIFY_CLIENT_ID: undefined }],
    ["encryption key", { WHOOP_TOKEN_ENCRYPTION_KEY: "" }],
    ["https redirect", { SPOTIFY_REDIRECT_URI: "http://api.example.test/integrations/spotify/callback" }],
    ["OS base URL", { OS_BASE_URL: "" }],
  ])("refuses to start OAuth without a valid %s", async (_name, overrides) => {
    const response = await createApp().request(
      "/v1/integrations/spotify/connect",
      bearer("POST"),
      { ...env, ...overrides } as Env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Spotify integration is not configured" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM spotify_oauth_states").get()).toEqual({ count: 0 });
  });

  it("exchanges the code with client credentials and stores only encrypted tokens", async () => {
    const app = createApp();
    const state = await startConnect(app);
    const { callsTo } = stubSpotifyFetch({ token: () => jsonResponse(TOKEN_RESPONSE) });

    const response = await app.request(`/integrations/spotify/callback?code=fixture-code&state=${state}`, {}, env);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CONNECTED_REDIRECT);
    const [tokenRequest] = callsTo("/api/token");
    expect(tokenRequest.method).toBe("POST");
    expect(tokenRequest.headers.get("authorization"))
      .toBe(`Basic ${btoa("test-spotify-client-id:test-spotify-client-secret")}`);
    const form = new URLSearchParams(await tokenRequest.text());
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "fixture-code",
      redirect_uri: ENV.SPOTIFY_REDIRECT_URI,
    });

    const row = connectionRow(sqlite)!;
    expect(row.status).toBe("active");
    expect(row.credential_version).toBe(1);
    expect(row.access_token_expires_at).toBe("2026-09-30T13:00:00.000Z");
    expect(row.granted_scopes).toBe("user-read-currently-playing user-read-recently-played");
    expect(JSON.stringify(row)).not.toContain("fixture-spotify-access-token");
    expect(JSON.stringify(row)).not.toContain("fixture-spotify-refresh-token");

    const repository = new SpotifyRepository(env.DB, KEY);
    await expect(repository.getAccessToken(1)).resolves.toBe("fixture-spotify-access-token");
    await expect(repository.getRefreshToken(1)).resolves.toBe("fixture-spotify-refresh-token");
  });

  it("rejects replayed, unknown, and expired states before any code exchange", async () => {
    const app = createApp();
    const state = await startConnect(app);
    const expiredState = await startConnect(app);
    const { fetchMock } = stubSpotifyFetch({ token: () => jsonResponse(TOKEN_RESPONSE) });

    const first = await app.request(`/integrations/spotify/callback?code=c1&state=${state}`, {}, env);
    const replay = await app.request(`/integrations/spotify/callback?code=c2&state=${state}`, {}, env);
    const unknown = await app.request("/integrations/spotify/callback?code=c3&state=never-issued", {}, env);
    const missing = await app.request("/integrations/spotify/callback?code=c4", {}, env);
    currentTime = new Date(Date.parse(NOW) + 11 * 60 * 1000);
    const expired = await app.request(`/integrations/spotify/callback?code=c5&state=${expiredState}`, {}, env);

    expect(first.headers.get("location")).toBe(CONNECTED_REDIRECT);
    for (const response of [replay, unknown, missing, expired]) {
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(FAILED_REDIRECT);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("consumes the state and fails closed when the owner denies access", async () => {
    const app = createApp();
    const state = await startConnect(app);
    const { fetchMock } = stubSpotifyFetch({});

    const denied = await app.request(`/integrations/spotify/callback?error=access_denied&state=${state}`, {}, env);
    const retry = await app.request(`/integrations/spotify/callback?code=late&state=${state}`, {}, env);

    expect(denied.headers.get("location")).toBe(FAILED_REDIRECT);
    expect(retry.headers.get("location")).toBe(FAILED_REDIRECT);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(connectionRow(sqlite)).toBeUndefined();
  });

  it("redirects failures without leaking the code, state, or upstream body", async () => {
    const app = createApp();
    const state = await startConnect(app);
    stubSpotifyFetch({
      token: () => jsonResponse({ error: "invalid_grant", error_description: "upstream-secret-detail" }, { status: 400 }),
    });

    const response = await app.request(`/integrations/spotify/callback?code=redacted-code&state=${state}`, {}, env);

    expect(response.headers.get("location")).toBe(FAILED_REDIRECT);
    expect(await response.text()).toBe("");
    expect(connectionRow(sqlite)).toBeUndefined();
  });

  it("reconnecting replaces the grant, bumps the credential version, and clears the cache", async () => {
    const app = createApp();
    stubSpotifyFetch({ token: () => jsonResponse(TOKEN_RESPONSE) });
    await app.request(`/integrations/spotify/callback?code=a&state=${await startConnect(app)}`, {}, env);
    sqlite.prepare("UPDATE spotify_connections SET now_json = '{}', now_fetched_at = ?").run(NOW);

    stubSpotifyFetch({
      token: () => jsonResponse({ ...TOKEN_RESPONSE, access_token: "second-access", refresh_token: "second-refresh" }),
    });
    await app.request(`/integrations/spotify/callback?code=b&state=${await startConnect(app)}`, {}, env);

    const row = connectionRow(sqlite)!;
    expect(row.credential_version).toBe(2);
    expect(row.now_json).toBeNull();
    await expect(new SpotifyRepository(env.DB, KEY).getRefreshToken(2)).resolves.toBe("second-refresh");
  });

  it("reports status without any token material", async () => {
    const app = createApp();
    const before = await app.request("/v1/integrations/spotify", bearer(), env);
    expect(await before.json()).toEqual({ status: "not_connected" });

    stubSpotifyFetch({ token: () => jsonResponse(TOKEN_RESPONSE) });
    await app.request(`/integrations/spotify/callback?code=a&state=${await startConnect(app)}`, {}, env);
    const after = await app.request("/v1/integrations/spotify", bearer(), env);
    const body = await after.json();

    expect(body).toEqual({
      status: "active",
      granted_scopes: ["user-read-currently-playing", "user-read-recently-played"],
      connected_at: NOW,
      refreshed_at: null,
      disconnected_at: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/token|ciphertext|nonce/i);
  });

  it("disconnects by deleting stored tokens and cache, and 409s when not connected", async () => {
    const app = createApp();
    const notConnected = await app.request("/v1/integrations/spotify", bearer("DELETE"), env);
    expect(notConnected.status).toBe(409);

    stubSpotifyFetch({ token: () => jsonResponse(TOKEN_RESPONSE) });
    await app.request(`/integrations/spotify/callback?code=a&state=${await startConnect(app)}`, {}, env);
    sqlite.prepare("UPDATE spotify_connections SET now_json = '{}', now_fetched_at = ?").run(NOW);

    const response = await app.request("/v1/integrations/spotify", bearer("DELETE"), env);
    const again = await app.request("/v1/integrations/spotify", bearer("DELETE"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(again.status).toBe(409);
    expect(connectionRow(sqlite)).toMatchObject({
      status: "disconnected",
      access_token_ciphertext: null,
      access_token_nonce: null,
      refresh_token_ciphertext: null,
      refresh_token_nonce: null,
      now_json: null,
    });
  });
});
