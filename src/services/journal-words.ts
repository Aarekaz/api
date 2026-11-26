import type { Env } from "../types/env";

// Journal word counts, stored so /v1/journal/stats needn't read a year of
// bodies (migration 0055). A count belongs to one document version: every
// write that changes a body bumps the version, so a row for an older version
// is ignored and the entry is counted from its body, as it always was. Before
// 0055 is applied nothing is stored and everything is counted from bodies.

const LIVE_JOURNAL = "d.kind = 'journal' AND d.deleted_at IS NULL";

export function countWords(body: string): number {
  const words = body.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return words ? words.length : 0;
}

const missingTable = (error: unknown) => /no such table: journal_words/i.test(String(error));

const upsert = (env: Env, row: { id: string; version: number; body: string }) => env.DB.prepare(
  `INSERT INTO journal_words (document_id, version, words) VALUES (?, ?, ?)
   ON CONFLICT(document_id) DO UPDATE SET version = excluded.version, words = excluded.words
   WHERE excluded.version >= journal_words.version`,
).bind(row.id, row.version, countWords(row.body));

/** Stores an entry's count after a write. Never fails the write it follows. */
export async function recordWords(env: Env, row: { id: string; version: number; body: string }): Promise<void> {
  try {
    await upsert(env, row).run();
  } catch (error) {
    if (!missingTable(error)) console.error("journal word count failed", error);
  }
}

/**
 * Words per entry for a window of `when` (the journal's sort expression):
 * `{ at, words }`, counted from the body only where no current count is
 * stored. Reads the same rows, and gives the same numbers, as counting every body.
 */
export async function wordsBetween(env: Env, when: string, from: string, to: string): Promise<Array<{ at: string; words: number }>> {
  const stored = env.DB.prepare(
    `SELECT ${when} AS at, w.words AS words, CASE WHEN w.words IS NULL THEN d.body END AS body
     FROM documents d LEFT JOIN journal_words w ON w.document_id = d.id AND w.version = d.version
     WHERE ${LIVE_JOURNAL} AND ${when} >= ? AND ${when} < ?`,
  ).bind(from, to);
  const rows = await stored.all<{ at: string; words: number | null; body: string | null }>().catch(async (error: unknown) => {
    if (!missingTable(error)) throw error;
    return env.DB.prepare(
      `SELECT ${when} AS at, NULL AS words, body FROM documents d WHERE ${LIVE_JOURNAL} AND ${when} >= ? AND ${when} < ?`,
    ).bind(from, to).all<{ at: string; words: null; body: string }>();
  });
  return rows.results.map((r) => ({ at: r.at, words: r.words ?? countWords(r.body ?? "") }));
}

/**
 * Counts up to `limit` live entries that have no current count. Safe to run at
 * any time and as often as you like: it only writes journal_words, and a row
 * already current is never rewritten. `more` says whether to call again.
 */
export async function backfillJournalWords(env: Env, limit = 200): Promise<{ counted: number; more: boolean }> {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.version, d.body FROM documents d
     LEFT JOIN journal_words w ON w.document_id = d.id AND w.version = d.version
     WHERE ${LIVE_JOURNAL} AND w.document_id IS NULL
     ORDER BY d.id LIMIT ?`,
  ).bind(limit + 1).all<{ id: string; version: number; body: string }>().catch((error: unknown) => {
    if (!missingTable(error)) throw error;
    throw Object.assign(new Error("Apply migration 0055 (journal_words) first"), { status: 503, code: "unavailable" });
  });
  const batch = results.slice(0, limit);
  if (batch.length) await env.DB.batch(batch.map((row) => upsert(env, row)));
  return { counted: batch.length, more: results.length > limit };
}
