import type { Env } from "../types/env";
import { backupPath, toMarkdown } from "./documents-core";
import type { DocumentRow } from "./documents";
import { vaultConfig } from "./vault";

// Nightly one-way backup: documents changed since the last run are written to
// the GitHub vault repo as Markdown. Cloudflare is the source of truth; the
// repo is a readable copy with history.

const JOB = "vault_backup";
const BATCH = 60;

export async function recordJob(env: Env, job: string, outcome: { ok: boolean; error?: string; cursor?: string }, now = new Date()) {
  const stamp = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO job_runs (job, last_started_at, last_success_at, last_error_at, last_error, cursor)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(job) DO UPDATE SET
       last_started_at = excluded.last_started_at,
       last_success_at = COALESCE(excluded.last_success_at, job_runs.last_success_at),
       last_error_at = COALESCE(excluded.last_error_at, job_runs.last_error_at),
       last_error = CASE WHEN excluded.last_error_at IS NOT NULL THEN excluded.last_error ELSE job_runs.last_error END,
       cursor = COALESCE(excluded.cursor, job_runs.cursor)`,
  ).bind(job, stamp, outcome.ok ? stamp : null, outcome.ok ? null : stamp, outcome.error ?? null, outcome.cursor ?? null).run();
}

async function github(env: Env, path: string, init: RequestInit = {}) {
  const { token } = vaultConfig(env);
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "anurag-os-api",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

/** Writes all changed documents as one commit using the Git Data API. */
export async function runVaultBackup(env: Env, now = new Date()): Promise<{ written: number }> {
  const { repo, branch } = vaultConfig(env);
  const state = await env.DB.prepare("SELECT cursor FROM job_runs WHERE job = ?").bind(JOB).first<{ cursor: string | null }>();
  const since = state?.cursor ?? "1970-01-01T00:00:00.000Z";
  const { results } = await env.DB.prepare(
    "SELECT * FROM documents WHERE updated_at > ? AND deleted_at IS NULL ORDER BY updated_at ASC LIMIT ?",
  ).bind(since, BATCH).all<DocumentRow>();
  if (results.length === 0) {
    await recordJob(env, JOB, { ok: true }, now);
    return { written: 0 };
  }

  try {
    const ref = await (await github(env, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).json() as { object: { sha: string } };
    const parent = ref.object.sha;
    const commit = await (await github(env, `/repos/${repo}/git/commits/${parent}`)).json() as { tree: { sha: string } };
    const tree = results.map((doc) => ({
      path: backupPath(doc), mode: "100644", type: "blob", content: toMarkdown(doc),
    }));
    const newTree = await (await github(env, `/repos/${repo}/git/trees`, {
      method: "POST", body: JSON.stringify({ base_tree: commit.tree.sha, tree }),
    })).json() as { sha: string };
    const newCommit = await (await github(env, `/repos/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: `anurag.os backup: ${results.length} document${results.length === 1 ? "" : "s"}`, tree: newTree.sha, parents: [parent] }),
    })).json() as { sha: string };
    const update = await github(env, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH", body: JSON.stringify({ sha: newCommit.sha }),
    });
    if (!update.ok) throw new Error(`GitHub ref update failed: ${update.status}`);
    await recordJob(env, JOB, { ok: true, cursor: results[results.length - 1].updated_at }, now);
    return { written: results.length };
  } catch (error) {
    await recordJob(env, JOB, { ok: false, error: error instanceof Error ? error.message : String(error) }, now);
    throw error;
  }
}

/** Runs once a day from the 5-minute cron (first tick after 09:00 UTC ≈ 4–5 AM Eastern). */
export async function maybeRunVaultBackup(env: Env, now = new Date()) {
  if (!env.VAULT_GITHUB_TOKEN || now.getUTCHours() !== 9 || now.getUTCMinutes() >= 5) return;
  try {
    // Several batches in one tick so a busy day still fits in one night.
    for (let i = 0; i < 5; i++) {
      const { written } = await runVaultBackup(env, now);
      if (written < BATCH) break;
    }
  } catch (error) {
    console.error("vault backup failed", error);
  }
}

