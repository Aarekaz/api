import type { Env } from "../types/env";

/**
 * A version number per kind of data (migrations/0046_data_versions.sql),
 * bumped on every write, so reads can send an ETag and answer 304.
 *
 * Both calls tolerate a database without the table (the migration not applied
 * yet): reads then go without an ETag, writes skip the bump. That is also why
 * the bump runs on its own after a write, not inside the write's batch.
 */
export type DataName = "places";

/** The current version, 0 before the first write, or null when versions aren't available. */
export async function dataVersion(env: Env, name: DataName): Promise<number | null> {
  try {
    const row = await env.DB.prepare("SELECT version FROM data_versions WHERE name = ?").bind(name).first<{ version: number }>();
    return Number(row?.version ?? 0);
  } catch {
    return null;
  }
}

/** Moves `name` one version on. */
export async function bumpDataVersion(env: Env, name: DataName, now = new Date()): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO data_versions (name, version, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(name) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`,
    ).bind(name, now.toISOString()).run();
  } catch (error) {
    // Before the migration is applied there is nothing to bump; anything else is worth a log line.
    if (!String(error).includes("no such table")) console.error(`data version bump failed (${name})`, error);
  }
}
