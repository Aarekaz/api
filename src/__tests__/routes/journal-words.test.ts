import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import journalRoute from "../../routes/journal";
import adminRoute from "../../routes/admin";
import { backfillJournalWords, countWords } from "../../services/journal-words";
import { allMigrations, testD1 } from "../helpers/d1";

// Migration 0055: /v1/journal/stats reads stored word counts instead of every
// body, and the list and stats read an index on when entries happened. The
// answers must be what counting the bodies gave, with or without 0055, and
// whether or not a count is current.

const WITHOUT = allMigrations().filter((name) => name !== "0055_journal_reads.sql");

function setup(migrations: string[] | "all") {
  const d1 = testD1({ migrations });
  const env = { DB: d1.DB } as Env;
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/journal", journalRoute);
  const send = async (path: string, method = "GET", body?: unknown) => (await root.request(path, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
  }, env)).json() as Promise<Record<string, unknown>>;
  return { d1, env, send };
}

const ENTRIES: Array<[string, string]> = [
  ["One two three.", "2026-11-21T23:30:00-05:00"],
  ["Ran by the river — it's cold, then coffee.", "2026-11-22T09:00:00-05:00"],
  ["", "2026-11-22T21:00:00-05:00"],
  ["Écrit en français, deux mots de plus.", "2026-11-23T07:00:00+05:45"],
  ["Last year.", "2025-06-01T12:00:00Z"],
];

async function write(send: ReturnType<typeof setup>["send"]) {
  const ids: string[] = [];
  for (const [body, happened_at] of ENTRIES) ids.push((await send("/v1/journal", "POST", { body, happened_at })).id as string);
  // An edit changes the count: the stored row moves to the new version.
  const first = await send(`/v1/journal/${ids[0]}`);
  await send(`/v1/journal/${ids[0]}`, "PATCH", { version: first.version, body: "One two three four five." });
  return ids;
}

const STATS = [
  "/v1/journal/stats?tz=America/New_York&today=2026-11-24",
  "/v1/journal/stats?today=2026-11-24",
  "/v1/journal/stats?from=2025-01-01&to=2026-12-31&tz=Asia/Kathmandu",
];

describe("journal word counts (0055)", () => {
  it("stats are the same with stored counts as from bodies", async () => {
    const before = setup(WITHOUT);
    const after = setup("all");
    await write(before.send);
    const ids = await write(after.send);
    const stored = after.d1.db.prepare("SELECT document_id, version, words FROM journal_words ORDER BY document_id").all() as Array<{ document_id: string; version: number; words: number }>;
    expect(stored).toHaveLength(ENTRIES.length);
    expect(stored.find((row) => row.document_id === ids[0])).toMatchObject({ version: 2, words: 5 });
    for (const path of STATS) expect(await after.send(path)).toEqual(await before.send(path));
    // 07:00 at +05:45 is the 22nd in New York.
    expect((await after.send(STATS[0])).totals).toEqual({ entries: 4, words: 5 + 8 + 0 + 7, days: 2 });
  });

  it("a count from an older version is ignored and the body counted", async () => {
    const { d1, send } = setup("all");
    const ids = await write(send);
    // Written straight to D1 the way any body change is: the version moves.
    d1.db.prepare("UPDATE documents SET body = 'just two', version = version + 1 WHERE id = ?").run(ids[1]);
    const stats = await send(STATS[0]) as { days: Array<{ day: string; words: number }> };
    expect(stats.days.find((d) => d.day === "2026-11-22")).toEqual({ day: "2026-11-22", entries: 3, words: 2 + 0 + 7 });
  });

  it("the backfill counts entries without a current count, in bounded passes, and is safe to repeat", async () => {
    const { d1, env, send } = setup("all");
    await write(send);
    const expected = await send(STATS[2]);
    d1.db.exec("DELETE FROM journal_words");
    d1.db.exec("UPDATE documents SET version = version + 1 WHERE kind = 'journal' AND id = (SELECT MIN(id) FROM documents)");
    expect(await backfillJournalWords(env, 2)).toEqual({ counted: 2, more: true });
    expect(await backfillJournalWords(env, 2)).toEqual({ counted: 2, more: true });
    expect(await backfillJournalWords(env, 2)).toEqual({ counted: 1, more: false });
    expect(await backfillJournalWords(env, 2)).toEqual({ counted: 0, more: false });
    const rows = d1.db.prepare(`SELECT d.body, d.version AS dv, w.version AS wv, w.words FROM documents d
      JOIN journal_words w ON w.document_id = d.id`).all() as Array<{ body: string; dv: number; wv: number; words: number }>;
    expect(rows).toHaveLength(ENTRIES.length);
    for (const row of rows) expect([row.wv, row.words]).toEqual([row.dv, countWords(row.body)]);
    expect(await send(STATS[2])).toEqual(expected);
    // Before 0055 there is nothing to fill and the stats still answer.
    const old = setup(WITHOUT);
    await write(old.send);
    expect(await old.send(STATS[2])).toEqual(expected);
  });

  it("POST /v1/admin/journal-words runs one pass, and says to migrate first before 0055", async () => {
    for (const [migrations, status, body] of [
      ["all", 200, { counted: 0, more: false }],
      [WITHOUT, 503, { error: { code: "unavailable", message: "Apply migration 0055 (journal_words) first" } }],
    ] as const) {
      const { d1, env } = setup(migrations as string[] | "all");
      const res = await adminRoute.request("/journal-words", { method: "POST" }, env);
      expect([res.status, await res.json()]).toEqual([status, body]);
      d1.db.close();
    }
  });

  it("the list and stats walk the index instead of sorting or opening every row", async () => {
    const { d1, send } = setup("all");
    await write(send);
    const first = await send("/v1/journal?limit=2") as { next_cursor: string };
    d1.queries.length = 0;
    await send(`/v1/journal?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`);
    await send(STATS[0]);
    const plans = d1.queries.filter((sql) => /FROM documents/.test(sql) && !/journal_words w ON w.document_id = d.id AND w.version = d.version\s+WHERE d.kind = 'journal' AND d.deleted_at IS NULL AND w.document_id IS NULL/.test(sql))
      .map((sql) => (d1.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from(sql.matchAll(/\?/g), () => "2026-01-01")) as Array<{ detail: string }>)
        .map((row) => row.detail).join(" | "));
    expect(plans.length).toBeGreaterThanOrEqual(3);
    for (const plan of plans) {
      expect(plan).toMatch(/^SEARCH (documents|d) USING INDEX documents_journal_when \(kind=\?/);
      expect(plan).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    }
  });
});

