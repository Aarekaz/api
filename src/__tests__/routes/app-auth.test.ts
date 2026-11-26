import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import appAuthRoute, { signOutRoute } from "../../routes/app-auth";
import { requireAuth } from "../../middleware/auth";

/** Just enough of D1 for the two app-auth tables. */
function fakeDb() {
  const states = new Map<string, { expires_at: string; consumed_at: string | null }>();
  const sessions = new Map<string, { github_id: string; revoked_at: string | null }>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith("INSERT INTO app_oauth_states")) {
                states.set(args[0] as string, { expires_at: args[2] as string, consumed_at: null });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE app_oauth_states")) {
                const [now, hash, notExpired] = args as string[];
                const row = states.get(hash);
                if (!row || row.consumed_at || row.expires_at <= notExpired) return { meta: { changes: 0 } };
                row.consumed_at = now;
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("INSERT INTO app_sessions")) {
                sessions.set(args[0] as string, { github_id: args[1] as string, revoked_at: null });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE app_sessions")) {
                const row = sessions.get(args[1] as string);
                if (row && !row.revoked_at) row.revoked_at = args[0] as string;
                return { meta: { changes: row ? 1 : 0 } };
              }
              throw new Error(`unexpected SQL ${sql}`);
            },
            async first() {
              const row = sessions.get(args[0] as string);
              return row && !row.revoked_at ? { github_id: row.github_id } : null;
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, states, sessions };
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    API_TOKEN: "owner-api-token",
    API_BASE_URL: "https://api.anuragd.me",
    APP_GITHUB_CLIENT_ID: "client-id",
    APP_GITHUB_CLIENT_SECRET: "client-secret",
    AUTHORIZED_GITHUB_ID: "42",
  } as Env;
}

function app() {
  const root = new Hono<{ Bindings: Env }>();
  root.route("/auth/app", appAuthRoute);
  root.use("/v1/*", requireAuth);
  root.get("/v1/ping", (c) => c.json({ ok: true }));
  root.route("/v1/app/signout", signOutRoute);
  return root;
}

function mockGitHub(userId: number) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gh-token" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: userId, login: "Aarekaz" }), { status: 200 });
  }));
}

async function startState(root: Hono<{ Bindings: Env }>, env: Env): Promise<string> {
  const res = await root.request("/auth/app/github/start", {}, env);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(location.searchParams.get("redirect_uri")).toBe("https://api.anuragd.me/auth/app/github/callback");
  expect(location.searchParams.get("scope")).toBe("");
  return location.searchParams.get("state")!;
}

afterEach(() => vi.unstubAllGlobals());

describe("app sign-in", () => {
  it("is off until configured", async () => {
    const res = await app().request("/auth/app/github/start", {}, { DB: fakeDb().db } as Env);
    expect(res.status).toBe(503);
  });

  it("signs in the owner and the session works as a Bearer token", async () => {
    const { db } = fakeDb();
    const env = makeEnv(db);
    const root = app();
    mockGitHub(42);

    const state = await startState(root, env);
    const callback = await root.request(`/auth/app/github/callback?code=abc&state=${state}`, {}, env);
    const redirect = new URL(callback.headers.get("location")!);
    expect(redirect.protocol).toBe("anuragos:");
    const token = redirect.searchParams.get("token")!;
    expect(token.length).toBeGreaterThanOrEqual(32);

    const ok = await root.request("/v1/ping", { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(ok.status).toBe(200);

    // States are single use.
    const replay = await root.request(`/auth/app/github/callback?code=abc&state=${state}`, {}, env);
    expect(new URL(replay.headers.get("location")!).searchParams.get("error")).toBe("expired");

    // Signing out revokes the session.
    await root.request("/v1/app/signout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }, env);
    const after = await root.request("/v1/ping", { headers: { Authorization: `Bearer ${token}` } }, env);
    // A signed-out session is unknown, not forbidden (ADR 0014).
    expect(after.status).toBe(401);
  });

  it("refuses anyone else's GitHub account", async () => {
    const { db, sessions } = fakeDb();
    const env = makeEnv(db);
    const root = app();
    mockGitHub(7);
    const state = await startState(root, env);
    const res = await root.request(`/auth/app/github/callback?code=abc&state=${state}`, {}, env);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("not_allowed");
    expect(sessions.size).toBe(0);
  });

  it("rejects unknown states", async () => {
    const { db } = fakeDb();
    const res = await app().request("/auth/app/github/callback?code=abc&state=made-up", {}, makeEnv(db));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("expired");
  });

  it("still accepts the owner API token and rejects junk", async () => {
    const { db } = fakeDb();
    const env = makeEnv(db);
    const root = app();
    expect((await root.request("/v1/ping", { headers: { Authorization: "Bearer owner-api-token" } }, env)).status).toBe(200);
    expect((await root.request("/v1/ping", { headers: { Authorization: "Bearer nope" } }, env)).status).toBe(401);
    expect((await root.request("/v1/ping", {}, env)).status).toBe(401);
  });
});
