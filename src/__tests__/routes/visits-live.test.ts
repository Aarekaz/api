// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
// @ts-expect-error same as above (node:sqlite is Node's built-in SQLite).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import visitsRoute from "../../routes/visits";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0007_location.sql", "utf8"));
  db.exec("ALTER TABLE location_history ADD COLUMN updated_at TEXT");
  db.exec(readFileSync("migrations/0027_visits.sql", "utf8"));
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async run() {
      const info = db.prepare(sql).run(...args) as { changes: number };
      return { meta: { changes: Number(info.changes) } };
    },
    async first<T>() { return (db.prepare(sql).get(...args) as T) ?? null; },
    async all<T>() { return { results: db.prepare(sql).all(...args) as T[] }; },
  });
  const DB = {
    prepare: (sql: string) => statement(sql),
    async batch(list: Array<{ run: () => Promise<unknown> }>) { const out = []; for (const s of list) out.push(await s.run()); return out; },
  } as unknown as D1Database;
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/visits", visitsRoute);
  const post = (visits: unknown[]) => root.request("/v1/visits", { method: "POST", body: JSON.stringify({ visits }), headers: { "Content-Type": "application/json" } }, { DB } as Env);
  return { db, post };
}

const stop = (departed: string | null) => ({
  latitude: 38.806, longitude: -77.058, arrived_at: "2026-11-24T16:31:04Z", departed_at: departed,
  place: "King St", source: "visit", source_key: "visit:1795537864",
});

describe("live visits", () => {
  it("fills in the departure when the phone sends the stop again", async () => {
    const { db, post } = setup();
    await post([stop(null)]);
    await post([stop("2026-11-24T16:37:32Z")]);
    const rows = db.prepare("SELECT arrived_at, departed_at FROM visits").all() as Array<{ departed_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].departed_at).toContain("16:37:32");
  });

  it("never overwrites a departure it already has, or one before the arrival", async () => {
    const { db, post } = setup();
    await post([stop("2026-11-24T16:37:32Z")]);
    await post([stop("2026-11-24T18:00:00Z")]);
    const other = { ...stop("2026-11-24T10:00:00Z"), source_key: "visit:2" };
    await post([{ ...other, departed_at: null }]);
    await post([other]);
    const rows = db.prepare("SELECT source_key, departed_at FROM visits ORDER BY source_key").all() as Array<{ departed_at: string | null }>;
    expect(rows.map((r) => r.departed_at && r.departed_at.slice(11, 19))).toEqual(["16:37:32", null]);
  });
});
