// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import crowdRoute from "../../routes/crowd";
import type { Env } from "../../types/env";
import { allMigrations, testD1, type TestD1 } from "../helpers/d1";

// The public crowd: `{ tending, total }`. The total is kept by migration
// 0054's trigger instead of counted per request; it must stay exactly
// COUNT(DISTINCT visitor_hash) over every visit, before and after 0054.

const COUNTER = "0054_crowd_visitor_count.sql";
const before = allMigrations().filter((name) => name !== COUNTER);

const post = (d1: TestD1, body?: string, headers: Record<string, string> = {}) =>
  crowdRoute.request("/", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }, { DB: d1.DB } as Env);
const get = async (d1: TestD1) => (await crowdRoute.request("/", {}, { DB: d1.DB } as Env)).json();
const counted = (d1: TestD1) =>
  (d1.db.prepare("SELECT COUNT(DISTINCT visitor_hash) AS n FROM crowd_visits").get() as { n: number }).n;

describe("crowd total", () => {
  it.each([["with the counter", "all" as const], ["before 0054", before]])("%s matches a distinct count", async (_, migrations) => {
    const d1 = testD1({ migrations });
    // Earlier days, already in the table (one visitor on two days).
    d1.db.exec(`INSERT INTO crowd_visits (visitor_hash, day, ts) VALUES
      ('a', '2026-11-01', 1), ('a', '2026-11-02', 2), ('b', '2026-11-02', 3)`);
    if (migrations === "all") {
      // Written straight to the table, as a script would: the trigger counts them.
      expect((d1.db.prepare("SELECT visitors FROM crowd_totals").get() as { visitors: number }).visitors).toBe(2);
    }
    const seen: unknown[] = [];
    for (const id of ["x", "y", "x", "y", "z", "x"]) {
      const res = await post(d1, JSON.stringify({ id }));
      expect(res.status).toBe(200);
      seen.push(await res.json());
    }
    expect(seen.map((body) => (body as { total: number }).total)).toEqual([3, 4, 4, 4, 5, 5]);
    expect(seen.map((body) => (body as { tending: number }).tending)).toEqual([1, 2, 2, 2, 3, 3]);
    expect(await get(d1)).toEqual({ tending: 3, total: counted(d1) });
    expect(counted(d1)).toBe(5);
    d1.db.close();
  });

  it("the migration counts the visits already there, once each", () => {
    const d1 = testD1({ migrations: before });
    d1.db.exec(`INSERT INTO crowd_visits (visitor_hash, day, ts) VALUES
      ('a', '2026-11-01', 1), ('a', '2026-11-02', 2), ('b', '2026-11-02', 3), ('c', '2026-11-03', 4)`);
    d1.db.exec(readFileSync(`migrations/${COUNTER}`, "utf8"));
    expect(d1.db.prepare("SELECT id, visitors FROM crowd_totals").all()).toEqual([{ id: 1, visitors: 3 }]);
    // Same visitor, new day: a new row but not a new visitor.
    d1.db.exec("INSERT INTO crowd_visits (visitor_hash, day, ts) VALUES ('c', '2026-11-04', 5)");
    // Same visitor, same day: the upsert updates and the trigger doesn't fire.
    d1.db.exec("INSERT INTO crowd_visits (visitor_hash, day, ts) VALUES ('c', '2026-11-04', 6) ON CONFLICT(visitor_hash, day) DO UPDATE SET ts = 6");
    d1.db.exec("INSERT INTO crowd_visits (visitor_hash, day, ts) VALUES ('d', '2026-11-04', 7)");
    expect(d1.db.prepare("SELECT visitors FROM crowd_totals").get()).toEqual({ visitors: counted(d1) });
    expect(counted(d1)).toBe(4);
    // Applying it again changes nothing.
    d1.db.exec(readFileSync(`migrations/${COUNTER}`, "utf8"));
    expect(d1.db.prepare("SELECT visitors FROM crowd_totals").get()).toEqual({ visitors: 4 });
    d1.db.close();
  });
});

describe("crowd body limit", () => {
  it("refuses a body declared over 8 KB and records nothing", async () => {
    const d1 = testD1({ migrations: "all" });
    const body = JSON.stringify({ id: "x".repeat(9000) });
    const res = await post(d1, body, { "content-length": String(body.length) });
    expect([res.status, await res.json()]).toEqual([413, { error: "Payload too large" }]);
    expect(counted(d1)).toBe(0);
    d1.db.close();
  });

  it("an id within the limit is used as before; a missing body falls back to network identity", async () => {
    const d1 = testD1({ migrations: "all" });
    const body = JSON.stringify({ id: "x".repeat(4000) });
    expect((await post(d1, body, { "content-length": String(body.length) })).status).toBe(200);
    expect((await post(d1, undefined, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(200);
    expect(await get(d1)).toEqual({ tending: 2, total: 2 });
    d1.db.close();
  });
});
