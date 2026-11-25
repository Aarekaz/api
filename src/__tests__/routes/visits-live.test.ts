import { testD1 } from "../helpers/d1";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import visitsRoute from "../../routes/visits";

function setup(options: { versions?: boolean } = {}) {
  const { db, DB } = testD1({
    migrations: ["0007_location", "0027_visits", "0028_place_names", "0029_journeys", "0032_place_categories", "0039_saved_places", "0040_saved_place_notes",
      "0041_visit_guess", "0042_utc_offset", "0043_recorded_departure", "0044_visit_corrections", "0046_data_versions", "0048_local_date"],
    sql: "ALTER TABLE location_history ADD COLUMN updated_at TEXT",
  });
  if (options.versions === false) db.exec("DROP TABLE data_versions");
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/visits", visitsRoute);
  const get = (path: string, headers: Record<string, string> = {}) => root.request(path, { headers }, { DB } as Env);
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

describe("conditional GETs", () => {
  const places = "/v1/visits/places";

  it("answers 304 until a write changes the places", async () => {
    const { post, get } = setup();
    await post([stop("2026-11-24T16:37:32Z")]);
    const first = await get(places);
    const tag = first.headers.get("ETag")!;
    expect(tag).toMatch(/^W\/"places-1-/);
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
    const again = await get(places, { "If-None-Match": tag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    // A repeat changes nothing, so the tag holds.
    await post([stop("2026-11-24T16:37:32Z")]);
    expect((await get(places, { "If-None-Match": tag })).status).toBe(304);
    await post([{ ...stop("2026-11-24T18:00:00Z"), arrived_at: "2026-11-24T17:00:00Z", source_key: "visit:2" }]);
    const changed = await get(places, { "If-None-Match": tag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(tag);
  });

  it("gives each query its own tag", async () => {
    const { get } = setup();
    const a = (await get("/v1/visits/days?year=2024")).headers.get("ETag");
    const b = (await get("/v1/visits/days?year=2025")).headers.get("ETag");
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("moves on for every kind of places write", async () => {
    const { db, get, send, post } = setup();
    const version = () => (db.prepare("SELECT version FROM data_versions WHERE name = 'places'").get() as { version: number } | undefined)?.version ?? 0;
    await post([stop("2026-11-24T16:37:32Z")]);
    expect(version()).toBe(1);
    await send("/v1/visits/names", "POST", { names: [{ key: "38.806,-77.058", name: "King St" }] });
    expect(version()).toBe(2);
    const saved = await (await send("/v1/visits/saved", "POST", { name: "Home", latitude: 38.8, longitude: -77 })).json() as { id: number };
    await send(`/v1/visits/saved/${saved.id}`, "PATCH", { note: "the flat" });
    await send(`/v1/visits/saved/${saved.id}`, "DELETE", {});
    expect(version()).toBe(5);
    const id = (db.prepare("SELECT id FROM visits").get() as { id: number }).id;
    await send(`/v1/visits/${id}`, "PATCH", { note: "coffee" });
    await send("/v1/visits/journeys", "POST", { journeys: [{ started_at: "2026-11-24T16:00:00Z", mode: "walking", source: "phone" }] });
    const journey = (db.prepare("SELECT id FROM journeys").get() as { id: number }).id;
    await send(`/v1/visits/journeys/${journey}`, "PATCH", { mode: "running" });
    expect(version()).toBe(8);
    // Nothing found, nothing changed.
    await send("/v1/visits/999", "PATCH", { note: "x" });
    await send("/v1/visits/saved/999", "DELETE", {});
    expect(version()).toBe(8);
    expect((await get("/v1/visits/years")).headers.get("ETag")).toMatch(/^W\/"places-8-/);
  });

  it("leaves the sliding 30-day journeys window untagged", async () => {
    const { get } = setup();
    expect((await get("/v1/visits/journeys")).headers.get("ETag")).toBeNull();
    expect((await get("/v1/visits/journeys?start=2026-01-01")).headers.get("ETag")).toBeTruthy();
  });

  it("works as before on a database without data_versions", async () => {
    const { post, get } = setup({ versions: false });
    expect((await post([stop("2026-11-24T16:37:32Z")])).status).toBe(200);
    const res = await get(places);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
  });
});

describe("pages and errors", () => {
  const at = (i: number) => ({ ...stop(`2026-11-2${i}T12:00:00Z`), arrived_at: `2026-11-2${i}T10:00:00Z`, source_key: `v${i}` });

  it("pages visits newest first with next_cursor, keeping the old key", async () => {
    const { post, get } = setup();
    await post([at(1), at(2), at(3)]);
    type Page = { visits: Array<{ source_key: string }>; items: Array<{ source_key: string }>; next_cursor: string | null; sources: unknown[] };
    const one = await (await get("/v1/visits?limit=2")).json() as Page;
    expect(one.items.map((v) => v.source_key)).toEqual(["v3", "v2"]);
    expect(one.visits).toEqual(one.items);
    expect(one.sources).toHaveLength(1);
    expect(one.next_cursor).toBeTruthy();
    const two = await (await get(`/v1/visits?limit=2&cursor=${one.next_cursor}`)).json() as Page;
    expect(two.items.map((v) => v.source_key)).toEqual(["v1"]);
    expect(two.next_cursor).toBeNull();
  });

  it("pages journeys oldest first", async () => {
    const { send, get } = setup();
    await send("/v1/visits/journeys", "POST", { journeys: [1, 2, 3].map((i) => ({ started_at: `2026-11-2${i}T10:00:00Z`, mode: "walking", source: "phone" })) });
    type Page = { journeys: Array<{ started_at: string }>; items: Array<{ started_at: string }>; next_cursor: string | null };
    const one = await (await get("/v1/visits/journeys?start=2026-11-01&end=2026-12-01&limit=2")).json() as Page;
    expect(one.items.map((j) => j.started_at.slice(0, 10))).toEqual(["2026-11-21", "2026-11-22"]);
    expect(one.journeys).toEqual(one.items);
    const two = await (await get(`/v1/visits/journeys?start=2026-11-01&end=2026-12-01&limit=2&cursor=${one.next_cursor}`)).json() as Page;
    expect(two.items.map((j) => j.started_at.slice(0, 10))).toEqual(["2026-11-23"]);
    expect(two.next_cursor).toBeNull();
  });

  it("answers errors in the one shape", async () => {
    const { get, send } = setup();
    const bad = await get("/v1/visits/at?key=nowhere");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "invalid", message: "key must look like 38.898,-77.037" } });
    expect(bad.headers.get("ETag")).toBeNull();
    expect(await (await get("/v1/visits?cursor=nonsense")).json()).toMatchObject({ error: { code: "invalid" } });
    const missing = await send("/v1/visits/999", "PATCH", { note: "x" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });
});

describe("local_date at ingest", () => {
  const at = (arrived_at: string, extra: Record<string, unknown> = {}) => ({
    latitude: 40.7, longitude: -74, arrived_at, departed_at: null, source: "visit", source_key: `visit:${arrived_at}`, ...extra,
  });
  const dates = (db: ReturnType<typeof setup>["db"], table: string) =>
    (db.prepare(`SELECT local_date FROM ${table} ORDER BY id`).all() as Array<{ local_date: string | null }>).map((r) => r.local_date);

  it("is the date where it happened: the row's own offset", async () => {
    const { db, post, get } = setup();
    // Kathmandu (+5:45): 03:07 UTC on the 10th is 8:52 am, 23:30 UTC on the 9th is 5:15 am on the 10th.
    // At -4:00, 02:00 UTC on the 10th is 10 pm on the 9th.
    await post([at("2022-06-10T03:07:55Z", { utc_offset: 345 }), at("2022-06-09T23:30:00Z", { utc_offset: 345 }), at("2022-06-10T02:00:00Z", { utc_offset: -240 })]);
    expect(dates(db, "visits")).toEqual(["2022-06-10", "2022-06-10", "2022-06-09"]);
    // Shown in replies (visits are read through the shown_visits view, which picks the column up).
    const page = await (await get("/v1/visits?start=2022-06-01T00:00:00Z&end=2022-07-01T00:00:00Z")).json() as { items: Array<{ local_date: string }> };
    expect(page.items.map((v) => v.local_date).sort()).toEqual(["2022-06-09", "2022-06-10", "2022-06-10"]);
  });

  it("without an offset, New York's date, summer time included", async () => {
    const { db, post } = setup();
    await post([
      at("2026-11-25T03:00:00Z"),   // 10 pm EST on the 24th
      at("2026-11-25T05:30:00Z"),   // 12:30 am EST on the 25th
      at("2026-07-01T03:30:00Z"),   // 11:30 pm EDT on 30 June
      at("2026-07-01T04:30:00Z"),   // 12:30 am EDT on 1 July (EST would still say 30 June)
    ]);
    expect(dates(db, "visits")).toEqual(["2026-11-24", "2026-11-25", "2026-06-30", "2026-07-01"]);
  });

  it("moves to where it happened when a repeat brings the offset", async () => {
    const { db, post } = setup();
    await post([at("2026-11-25T03:00:00Z")]);
    expect(dates(db, "visits")).toEqual(["2026-11-24"]);
    await post([at("2026-11-25T03:00:00Z", { departed_at: "2026-11-25T04:00:00Z", utc_offset: 345 })]);
    expect(dates(db, "visits")).toEqual(["2026-11-25"]);
  });

  it("is written for journeys from when they started", async () => {
    const { db, send, get } = setup();
    await send("/v1/visits/journeys", "POST", { journeys: [
      { started_at: "2026-11-25T03:00:00Z", mode: "walking", source: "phone", source_key: "j1" },
      { started_at: "2026-11-25T03:00:00Z", mode: "flying", source: "phone", source_key: "j2", utc_offset: 345 },
    ] });
    expect(dates(db, "journeys")).toEqual(["2026-11-24", "2026-11-25"]);
    const page = await (await get("/v1/visits/journeys?start=2026-11-01&end=2026-12-01")).json() as { items: Array<{ local_date: string }> };
    expect(page.items.map((j) => j.local_date)).toEqual(["2026-11-24", "2026-11-25"]);
  });
});

describe("days come from local_date", () => {
  // Rows written straight into the table, so local_date can say something the
  // UTC time and offset alone wouldn't (proving the reads go by the column).
  const insert = (db: ReturnType<typeof setup>["db"], v: { arrived_at: string; departed_at?: string | null; utc_offset?: number | null; local_date: string | null; key: string }) =>
    db.prepare(`INSERT INTO visits (latitude, longitude, arrived_at, departed_at, source, source_key, created_at, utc_offset, local_date)
      VALUES (40.7, -74, ?, ?, 'visit', ?, '2026-01-01', ?, ?)`).run(v.arrived_at, v.departed_at ?? null, v.key, v.utc_offset ?? null, v.local_date);
  type Day = { visits: Array<{ source_key: string }>; journeys: Array<{ source_key: string }> };

  it("groups days, months, years and on-this-day by local_date, whatever ?offset= says", async () => {
    const { db, get } = setup();
    insert(db, { arrived_at: "2022-06-10T03:07:55Z", utc_offset: 345, local_date: "2022-06-11", key: "a" });
    for (const offset of ["", "&offset=-240", "&offset=600"]) {
      const days = await (await get(`/v1/visits/days?year=2022${offset}`)).json() as { days: Array<{ day: string }> };
      expect(days.days.map((d) => d.day)).toEqual(["2022-06-11"]);
      const day = await (await get(`/v1/visits/day?date=2022-06-11${offset}`)).json() as Day;
      expect(day.visits.map((v) => v.source_key)).toEqual(["a"]);
      const otd = await (await get(`/v1/visits/on-this-day?md=06-11${offset}`)).json() as Day;
      expect(otd.visits.map((v) => v.source_key)).toEqual(["a"]);
    }
    const months = await (await get("/v1/visits/months?offset=-240")).json() as { months: Array<{ month: string }> };
    expect(months.months.map((m) => m.month)).toEqual(["2022-06"]);
  });

  it("puts a visit on its local year, for the years and the places in a year", async () => {
    const { db, get } = setup();
    // 03:00 UTC on 1 Jan 2023 is 10 pm on New Year's Eve in New York.
    insert(db, { arrived_at: "2023-01-01T03:00:00Z", local_date: "2022-12-31", key: "nye" });
    const years = await (await get("/v1/visits/years")).json() as { years: Array<{ year: string }> };
    expect(years.years.map((y) => y.year)).toEqual(["2022"]);
    const in2022 = await (await get("/v1/visits/places?year=2022")).json() as { places: unknown[] };
    const in2023 = await (await get("/v1/visits/places?year=2023")).json() as { places: unknown[] };
    expect([in2022.places.length, in2023.places.length]).toEqual([1, 0]);
  });

  it("keeps a stay that began the night before and ran into the day", async () => {
    const { db, get } = setup();
    insert(db, { arrived_at: "2026-11-24T02:00:00Z", departed_at: "2026-11-24T13:00:00Z", utc_offset: -300, local_date: "2026-11-23", key: "night" });
    insert(db, { arrived_at: "2026-11-24T15:00:00Z", departed_at: "2026-11-24T16:00:00Z", utc_offset: -300, local_date: "2026-11-24", key: "day" });
    const day = await (await get("/v1/visits/day?date=2026-11-24")).json() as Day;
    expect(day.visits.map((v) => v.source_key)).toEqual(["night", "day"]);
    const before = await (await get("/v1/visits/day?date=2026-11-23")).json() as Day;
    expect(before.visits.map((v) => v.source_key)).toEqual(["night"]);
  });

  it("finds a day's journeys by local_date", async () => {
    const { db, get } = setup();
    db.exec(`INSERT INTO journeys (started_at, mode, source, source_key, created_at, utc_offset, local_date) VALUES
      ('2026-11-25T03:00:00Z', 'walking', 'phone', 'j1', '2026-01-01', NULL, '2026-11-24'),
      ('2026-11-25T03:00:00Z', 'flying', 'phone', 'j2', '2026-01-01', 345, '2026-11-25')`);
    const day = await (await get("/v1/visits/day?date=2026-11-24&offset=345")).json() as Day;
    expect(day.journeys.map((j) => j.source_key)).toEqual(["j1"]);
  });

  it("reads a row without local_date the old way: its own offset, else the reader's", async () => {
    const { db, get } = setup();
    insert(db, { arrived_at: "2022-06-10T03:07:55Z", utc_offset: 345, local_date: null, key: "own" });
    insert(db, { arrived_at: "2022-07-10T03:07:55Z", utc_offset: null, local_date: null, key: "reader" });
    db.exec(`INSERT INTO journeys (started_at, mode, source, source_key, created_at) VALUES ('2022-07-10T03:00:00Z', 'walking', 'phone', 'j', '2026-01-01')`);
    const east = await (await get("/v1/visits/days?year=2022&offset=-240")).json() as { days: Array<{ day: string }> };
    expect(east.days.map((d) => d.day)).toEqual(["2022-06-10", "2022-07-09"]);
    const day = await (await get("/v1/visits/day?date=2022-07-09&offset=-240")).json() as Day;
    expect(day.visits.map((v) => v.source_key)).toEqual(["reader"]);
    expect(day.journeys.map((j) => j.source_key)).toEqual(["j"]);
    const otd = await (await get("/v1/visits/on-this-day?md=06-10&offset=-240")).json() as Day;
    expect(otd.visits.map((v) => v.source_key)).toEqual(["own"]);
  });

  it("seeks the local_date index for a day, a year's days and on-this-day", async () => {
    const { db, DB } = testD1({
      migrations: ["0007_location", "0027_visits", "0028_place_names", "0029_journeys", "0032_place_categories", "0041_visit_guess",
        "0042_utc_offset", "0043_recorded_departure", "0044_visit_corrections", "0048_local_date"],
    });
    const seen: string[] = [];
    const spy = { prepare: (sql: string) => { seen.push(sql); return DB.prepare(sql); }, batch: DB.batch.bind(DB) } as unknown as D1Database;
    const env = { DB: spy } as Env;
    const places = await import("../../services/places");
    await places.visitDay(env, "2026-11-24", 0);
    await places.visitDays(env, "2026", 0);
    await places.onThisDay(env, "11-24", 0);
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join("\n");
    const reads = seen.filter((sql) => /local_date (=|BETWEEN|>=|IN)/.test(sql));
    expect(reads.length).toBe(4);
    for (const sql of reads) expect(plan(sql)).toMatch(/USING INDEX (visits|journeys)_local_date \(local_date/);
  });
});
