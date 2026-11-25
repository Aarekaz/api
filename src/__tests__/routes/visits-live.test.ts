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
  for (const m of ["0027_visits", "0028_place_names", "0029_journeys", "0041_visit_guess", "0042_utc_offset", "0043_recorded_departure", "0044_visit_corrections"]) {
    db.exec(readFileSync(`migrations/${m}.sql`, "utf8"));
  }
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
  const get = (path: string) => root.request(path, {}, { DB } as Env);
  const send = (path: string, method: string, body: unknown) =>
    root.request(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }, { DB } as Env);
  const post = (visits: unknown[]) => root.request("/v1/visits", { method: "POST", body: JSON.stringify({ visits }), headers: { "Content-Type": "application/json" } }, { DB } as Env);
  return { db, post, get, send };
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

describe("local days", () => {
  // 2022-06-10 03:07 UTC is 8:52 am in Kathmandu, but still the 9th in New York.
  const kathmandu = { latitude: 27.6697, longitude: 85.31, arrived_at: "2022-06-10T03:07:55Z", departed_at: "2022-06-10T04:19:55Z",
    source: "google-timeline", source_key: "gt:2022-06-10T03:07:55Z:x", utc_offset: 345 };

  it("puts a visit on the day where it happened, not the reader's", async () => {
    const { post, get } = setup();
    await post([kathmandu]);
    const day = await (await get("/v1/visits/day?date=2022-06-10&offset=-240")).json() as { visits: unknown[]; utc_offset: number };
    expect(day.visits).toHaveLength(1);
    expect(day.utc_offset).toBe(345);
    const before = await (await get("/v1/visits/day?date=2022-06-09&offset=-240")).json() as { visits: unknown[] };
    expect(before.visits).toHaveLength(0);
    const days = await (await get("/v1/visits/days?year=2022&offset=-240")).json() as { days: Array<{ day: string }> };
    expect(days.days.map((d) => d.day)).toEqual(["2022-06-10"]);
  });

  it("falls back to the reader's offset when a visit has none", async () => {
    const { post, get } = setup();
    await post([{ ...kathmandu, utc_offset: undefined, source_key: "k2" }]);
    const days = await (await get("/v1/visits/days?year=2022&offset=-240")).json() as { days: Array<{ day: string }> };
    expect(days.days.map((d) => d.day)).toEqual(["2022-06-09"]);
  });
});

describe("corrections", () => {
  it("hides a visit from every view but keeps the row; moves one keeping its old spot", async () => {
    const { db, post, get, send } = setup();
    await post([stop("2026-11-24T16:37:32Z"), { ...stop("2026-11-24T18:00:00Z"), source_key: "b", arrived_at: "2026-11-24T17:00:00Z" }]);
    const day = async () => (await (await get("/v1/visits/day?date=2026-11-24&offset=-300")).json() as { visits: Array<{ id: number }> }).visits;
    const [first, second] = await day();
    expect((await send(`/v1/visits/${first.id}`, "PATCH", { hidden: true, note: "Not a stop" })).status).toBe(200);
    expect((await day()).map((v) => v.id)).toEqual([second.id]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM visits").get()).toEqual({ n: 2 });
    const moved = await (await send(`/v1/visits/${second.id}`, "PATCH", { move_to: { latitude: 38.8042, longitude: -77.0473 } })).json() as Record<string, number>;
    expect(moved.latitude).toBe(38.8042);
    expect(moved.guess_latitude).toBe(38.806);
    expect((await send(`/v1/visits/${second.id}`, "PATCH", {})).status).toBe(400);
  });
});

describe("what the phone gets wrong", () => {
  it("skips a stay that ends before it starts", async () => {
    const { db, post } = setup();
    await post([{ ...stop("2026-11-24T16:16:27Z"), arrived_at: "2026-11-24T16:20:52Z", source_key: "backwards" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM visits").get()).toEqual({ n: 0 });
  });

  it("lets you say how you really travelled", async () => {
    const { db, send } = setup();
    db.exec(`INSERT INTO journeys (started_at, ended_at, distance_m, mode, source, source_key, created_at)
             VALUES ('2026-11-24T16:37:32Z', '2026-11-24T16:44:01Z', 1002, 'in passenger vehicle', 'phone', 'phone:1', '2026-11-24')`);
    const id = (db.prepare("SELECT id FROM journeys").get() as { id: number }).id;
    const fixed = await (await send(`/v1/visits/journeys/${id}`, "PATCH", { mode: "in bus" })).json() as { mode: string };
    expect(fixed.mode).toBe("in bus");
    expect((await send(`/v1/visits/journeys/${id}`, "PATCH", { mode: "teleport" })).status).toBe(400);
  });
});

describe("where you woke up", () => {
  it("starts a day with last night's stay, even one the phone never closed", async () => {
    const { post, get } = setup();
    await post([
      { latitude: 38.8602, longitude: -77.0534, arrived_at: "2026-11-24T00:48:00Z", departed_at: null, place: "Home", source: "visit", source_key: "night" },
      { ...stop("2026-11-24T16:37:00Z"), source_key: "day" },
    ]);
    const day = await (await get("/v1/visits/day?date=2026-11-24&offset=-300")).json() as { visits: Array<{ place: string | null; woke_here?: boolean }> };
    expect(day.visits.length).toBe(2);
    expect(day.visits[0].woke_here).toBe(true);
    expect(day.visits[0].place).toBe("Home");
  });
});
