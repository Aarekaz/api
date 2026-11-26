import type { Env } from "../types/env";

// Sign-in with GitHub (the apps) and connecting Spotify each insert a one-use
// state row per attempt, and nothing else ever deletes them. A row is useless
// once it has expired or been used: consuming needs `consumed_at IS NULL AND
// expires_at > now`, so a deleted row answers exactly as a spent one did. They
// are kept a day for debugging, as WHOOP's are (whoop/repository.ts
// pruneOperationalData, which already sweeps whoop_oauth_states).

const KEEP_MILLISECONDS = 24 * 60 * 60 * 1000;
// Bounded per tick; a backlog drains over a few hours.
const DELETE_LIMIT = 500;
const TABLES = ["app_oauth_states", "spotify_oauth_states"] as const;

/** On the first tick of each hour. */
export const isOAuthSweepTick = (now: Date) => now.getUTCMinutes() < 5;

/** Deletes up to DELETE_LIMIT spent or expired states per table; returns how many went. */
export async function pruneOAuthStates(env: Env, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - KEEP_MILLISECONDS).toISOString();
  const results = await env.DB.batch(TABLES.map((table) => env.DB.prepare(
    `DELETE FROM ${table} WHERE rowid IN (
       SELECT rowid FROM ${table}
       WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR expires_at < ?
       ORDER BY expires_at ASC LIMIT ?
     )`,
  ).bind(cutoff, cutoff, DELETE_LIMIT)));
  return results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
}
