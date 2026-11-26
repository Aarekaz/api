import { describe, expect, it } from "vitest";
import { consumeState, startSignIn } from "../../services/app-auth";
import { isOAuthSweepTick, pruneOAuthStates } from "../../services/oauth-states";
import type { Env } from "../../types/env";
import { testD1 } from "../helpers/d1";

// The hourly sweep of one-use OAuth states (apps' GitHub sign-in, Spotify):
// spent or expired a day ago goes; anything that could still be used stays.

const NOW = new Date("2026-11-26T09:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

describe("OAuth state sweep", () => {
  it.each(["app_oauth_states", "spotify_oauth_states"])("keeps live and recent states in %s", async (table) => {
    const d1 = testD1({ migrations: "all" });
    const insert = d1.db.prepare(`INSERT INTO ${table} (state_hash, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?)`);
    insert.run("expired-long-ago", at(-50), at(-49.8), null);
    insert.run("expired-an-hour-ago", at(-1.2), at(-1), null);
    insert.run("used-long-ago", at(-30), at(-29.8), at(-29.9));
    insert.run("used-just-now", at(-0.1), at(0.1), at(-0.05));
    insert.run("live", at(0), at(0.2), null);
    expect(await pruneOAuthStates({ DB: d1.DB } as Env, NOW)).toBe(2);
    const left = d1.db.prepare(`SELECT state_hash FROM ${table} ORDER BY state_hash`).all().map((row) => (row as { state_hash: string }).state_hash);
    expect(left).toEqual(["expired-an-hour-ago", "live", "used-just-now"]);
    d1.db.close();
  });

  it("a swept state is refused exactly as a spent one was", async () => {
    const d1 = testD1({ migrations: "all" });
    const env = { DB: d1.DB, APP_GITHUB_CLIENT_ID: "client" } as Env;
    const signIn = new URL(await startSignIn(env, "https://api.example.test/auth/app/github/start", new Date(at(-48))));
    const state = signIn.searchParams.get("state")!;
    expect(await consumeState(env, state, new Date(at(-47.95)))).toBe(true);
    expect(await consumeState(env, state, NOW)).toBe(false);
    expect(await pruneOAuthStates(env, NOW)).toBe(1);
    expect(await consumeState(env, state, NOW)).toBe(false);
    d1.db.close();
  });

  it("runs on the first tick of each hour", () => {
    expect(isOAuthSweepTick(new Date("2026-11-26T09:00:00Z"))).toBe(true);
    expect(isOAuthSweepTick(new Date("2026-11-26T09:04:59Z"))).toBe(true);
    expect(isOAuthSweepTick(new Date("2026-11-26T09:05:00Z"))).toBe(false);
  });
});
