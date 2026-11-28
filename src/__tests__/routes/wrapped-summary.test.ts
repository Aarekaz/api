import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import { testD1, type TestD1 } from "../helpers/d1";
import { bodyEtag } from "../../middleware/body-etag";
import wrappedRoute from "../../routes/wrapped";
import wrappedSummaryRoute from "../../routes/wrapped-summary";
import { offsetMinutes, sportName, startOfDay } from "../../services/wrapped-summary";

let d1: TestD1 | undefined;
afterEach(() => { d1?.db.close(); d1 = undefined; vi.useRealTimers(); });

const NY = "America/New_York";

function setup() {
  d1 = testD1({ migrations: "all" });
  const db = d1.db;
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...(args as never[]));
  const env = { DB: d1.DB, WAKATIME_TIMEZONE: NY, API_VERSION: "test" } as Env;
  const root = new Hono<{ Bindings: Env }>();
  root.use("/v1/*", bodyEtag);
  root.route("/v1/wrapped/summary", wrappedSummaryRoute);
  root.route("/v1/wrapped", wrappedRoute);
  let batches = 0;
  const batch = d1.DB.batch.bind(d1.DB);
  d1.DB.batch = ((statements: Parameters<typeof batch>[0]) => { batches++; return batch(statements); }) as typeof d1.DB.batch;
  const get = (query: string, headers: Record<string, string> = {}) => root.request(`/v1/wrapped/summary?${query}`, { headers }, env);
  return { db, run, env, get, batches: () => batches };
}

/** A little of everything in November 2026, some of it near midnight in New York. */
function seed(run: ReturnType<typeof setup>["run"]) {
  const at = "2026-11-01T00:00:00Z";
  run("INSERT INTO wakatime_days (date, total_seconds, total_minutes, created_at) VALUES ('2026-11-10', 7200, 120, ?), ('2026-11-11', 1800, 30, ?), ('2026-12-01', 999, 16, ?)", at, at, at);
  run("INSERT INTO wakatime_languages (date, name, total_seconds, total_minutes) VALUES ('2026-11-10', 'Swift', 5400, 90), ('2026-11-11', 'Swift', 1800, 30), ('2026-11-10', 'Other', 3600, 60), ('2026-11-10', 'Ruby', 30, 0)");
  run("INSERT INTO wakatime_hourly (date, hour, seconds) VALUES ('2026-11-10', 9, 3600), ('2026-11-10', 10, 3600)");
  run("INSERT INTO github_daily (date, count, created_at) VALUES ('2026-11-10', 3, ?), ('2026-11-12', 2, ?), ('2026-11-13', 0, ?)", at, at, at);
  run("INSERT INTO training_routines (id, name, created_at, updated_at) VALUES ('r', 'Push', ?, ?)", at, at);
  run(`INSERT INTO training_sets (routine_id, day, exercise, set_number, reps, weight, done_at) VALUES
       ('r', '2026-11-10', 'Bench', 1, 5, 100, '2026-11-10T12:00:00Z'), ('r', '2026-11-10', 'Bench', 2, 5, 100, '2026-11-10T12:45:00Z')`);
  // 23:30 in New York on the 24th is the 25th in UTC.
  run(`INSERT INTO music_plays (played_at, track_id, track, artists, duration_ms, created_at) VALUES
       ('2026-11-25T04:30:00Z', 'a', 'Song A', 'Band', 60000, ?), ('2026-11-24T15:00:00Z', 'a', 'Song A', 'Band', 60000, ?),
       ('2026-11-24T15:10:00Z', 'b', 'Song B', 'Other Band', 120000, ?), ('2026-10-31T12:00:00Z', 'a', 'Song A', 'Band', 60000, ?)`, at, at, at, at);
  run(`INSERT INTO documents (id, kind, folder, title, slug, body, created_at, updated_at, version) VALUES
       ('L1', 'link', '', 'An article', 'l1', '', '2026-11-03T10:00:00Z', '2026-11-03T10:00:00Z', 1),
       ('L2', 'link', '', 'Old article', 'l2', '', '2026-10-01T10:00:00Z', '2026-11-05T10:00:00Z', 1),
       ('N1', 'note', '', 'A note', 'n1', 'x', '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z', 1),
       ('W1', 'writing', '', 'A draft', 'w1', 'x', '2026-11-05T10:00:00Z', '2026-11-05T10:00:00Z', 1),
       ('J1', 'journal', '', '', 'j1', 'one two three', '2026-11-25T03:00:00Z', '2026-11-25T03:00:00Z', 1)`);
  run(`INSERT INTO links (document_id, url, site, reading_minutes, read_at) VALUES
       ('L1', 'https://a.example/1', 'a.example', 5, '2026-11-03T12:00:00Z'), ('L2', 'https://b.example/1', 'b.example', 7, '2026-11-05T12:00:00Z')`);
  const long = "This is a highlighted sentence that is long enough to be the quote of the month.";
  run(`INSERT INTO highlights (id, document_id, text, note, created_at, updated_at) VALUES
       ('H1', 'L1', ?, NULL, '2026-11-03T12:01:00Z', '2026-11-03T12:01:00Z'), ('H2', 'L1', 'short', 'mine', '2026-11-03T12:02:00Z', '2026-11-03T12:02:00Z')`, long);
  run("INSERT INTO posts (slug, title, content, published_at, created_at) VALUES ('p', 'A post', 'four words right here', '2026-11-20', ?), ('q', 'Draft', 'x', NULL, ?)", at, at);
  run("INSERT INTO shelf_items (id, type, title, status, rating, completed_at, date_added, created_at) VALUES (1, 'book', 'Dune', 'completed', 5, '2026-11-02', ?, ?), (2, 'movie', 'Heat', 'watched', 4, '2026-11-15T20:00:00Z', ?, ?), (3, 'show', 'Severance', 'watching', NULL, NULL, ?, ?)", at, at, at, at, at, at);
  run(`INSERT INTO shelf_log (item_id, kind, logged_at, episode, created_at) VALUES
       (1, 'finished', '2026-11-02T18:00:00Z', NULL, ?), (3, 'started', '2026-11-06T18:00:00Z', NULL, ?), (3, 'progress', '2026-11-07T18:00:00Z', 2, ?)`, at, at, at);
  run(`INSERT INTO apple_health_daily (date, steps, distance_walking_running, sleep_duration_minutes, resting_heart_rate, created_at) VALUES
       ('2026-11-10', 12000, 8.5, 420, 55, ?), ('2026-11-11', 3000, 2, 30, 57, ?)`, at, at);
  run(`INSERT INTO visits (latitude, longitude, arrived_at, departed_at, place, city, country, source, source_key, created_at, local_date) VALUES
       (38.8, -77.0, '2026-11-10T14:00:00Z', '2026-11-10T15:00:00Z', 'Cafe', 'Washington', 'US', 'visit', 'v1', ?, '2026-11-10'),
       (38.8, -77.0, '2026-10-10T14:00:00Z', '2026-10-10T15:00:00Z', 'Cafe', 'Washington', 'US', 'visit', 'v0', ?, '2026-10-10'),
       (40.7, -74.0, '2026-11-12T14:00:00Z', '2026-11-12T18:00:00Z', 'Museum', 'New York', 'US', 'visit', 'v2', ?, '2026-11-12')`, at, at, at);
}

type Summary = Record<string, any>;

describe("GET /v1/wrapped/summary", () => {
  it("sums every source for one period, cut to local days", async () => {
    vi.useFakeTimers({ now: new Date("2027-01-15T12:00:00Z"), toFake: ["Date"] });
    const { run, get } = setup();
    seed(run);
    const res = await get(`from=2026-11-01&to=2026-11-30&tz=${encodeURIComponent(NY)}`);
    expect(res.status).toBe(200);
    const s = await res.json() as Summary;
    expect(s.start).toBe("2026-11-01T04:00:00.000Z"); // EDT until 1 November, 02:00
    expect(s.until).toBe("2026-12-01T05:00:00.000Z");

    expect(s.code.seconds).toBe(9000);
    expect(s.code.daily).toEqual({ "2026-11-10": 7200, "2026-11-11": 1800 });
    expect(s.code.languages).toEqual([{ name: "Swift", value: 2 }]); // Other and under a minute are left out
    expect(s.code.hours[9]).toBe(1);
    expect(s.code.weekdays[1]).toBe(2); // 10 November 2026 is a Tuesday

    expect(s.github).toEqual({ total: 5, daily: { "2026-11-10": 3, "2026-11-12": 2 } });
    expect(s.training.sessions).toEqual([{ day: "2026-11-10", routine: "Push", sets: 2, volume: 1000, minutes: 45 }]);

    expect(s.music.plays).toBe(3);
    expect(s.music.minutes).toBe(4);
    expect(s.music.artists).toEqual([{ name: "Band", value: 2 }, { name: "Other Band", value: 1 }]);
    expect(s.music.tracks[0]).toEqual({ name: "Song A", detail: "Band", value: 2 });
    expect(s.music.per_day).toEqual({ "2026-11-24": 3 });
    expect(s.music.hours[23]).toBe(1);
    expect(s.music.hours[10]).toBe(2);

    expect(s.reading).toMatchObject({ saved: 1, read: 2, minutes: 12, highlights: 2, read_days: { "2026-11-03": 1, "2026-11-05": 1 } });
    expect(s.reading.quote.source).toBe("An article");
    expect(s.reading.most_marked).toEqual({ name: "An article", value: 2 });
    expect(s.writing).toEqual({ posts: [{ title: "A post", day: "2026-11-20", words: 4 }], notes_started: 1, drafts_started: 1 });
    expect(s.journal).toEqual({ days: { "2026-11-24": 3 }, entries: 1, words: 3 });

    expect(s.library.finished.map((e: Summary) => e.title)).toEqual(["Dune"]);
    expect(s.library.finished_items.map((e: Summary) => e.title)).toEqual(["Heat"]);
    expect(s.library).toMatchObject({ started: 1, episodes: 1 });

    expect(s.movement.steps).toEqual({ "2026-11-10": 12000, "2026-11-11": 3000 });
    expect(s.movement.walking_km).toBe(10.5);
    expect(s.movement.sleep).toEqual({ "2026-11-10": 7 });
    expect(s.movement.resting_hr).toBe(56);

    expect(s.places.places.map((p: Summary) => [p.name, p.visits, p.is_new])).toEqual([["Cafe", 1, false], ["Museum", 1, true]]);
    expect(s.places.countries).toEqual(["US"]);
    expect(s.places.per_day).toEqual({ "2026-11-10": 1, "2026-11-12": 1 });
  });

  it("keeps a past period until the next UTC day, with a strong ETag", async () => {
    vi.useFakeTimers({ now: new Date("2027-01-15T12:00:00Z"), toFake: ["Date"] });
    const { run, get } = setup();
    seed(run);
    const q = `from=2026-11-01&to=2026-11-30&tz=${encodeURIComponent(NY)}`;
    const first = await get(q);
    expect(first.headers.get("X-Derived-Cache")).toBe("miss");
    const tag = first.headers.get("ETag")!;
    expect(tag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    const body = await first.text();

    run("INSERT INTO github_daily (date, count, created_at) VALUES ('2026-11-20', 9, '2026-11-01')");
    const kept = await get(q);
    expect(kept.headers.get("X-Derived-Cache")).toBe("hit");
    expect(await kept.text()).toBe(body);
    expect((await get(q, { "If-None-Match": tag })).status).toBe(304);

    vi.setSystemTime(new Date("2027-01-16T00:30:00Z"));
    const next = await get(q);
    expect(next.headers.get("X-Derived-Cache")).toBe("miss");
    expect(((await next.json()) as Summary).github.total).toBe(14);
  });

  it("works out the current period on each request", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-20T12:00:00Z"), toFake: ["Date"] });
    const { run, get } = setup();
    seed(run);
    const res = await get(`from=2026-11-01&to=2026-11-30&tz=${encodeURIComponent(NY)}`);
    expect(res.headers.get("X-Derived-Cache")).toBe("bypass");
    run("INSERT INTO github_daily (date, count, created_at) VALUES ('2026-11-20', 9, '2026-11-01')");
    const again = await get(`from=2026-11-01&to=2026-11-30&tz=${encodeURIComponent(NY)}`);
    expect(((await again.json()) as Summary).github.total).toBe(14);
  });

  it("reads everything in one D1 batch, and an empty database is all zeros", async () => {
    const { get, batches } = setup();
    const s = await (await get("from=2026-11-01&to=2026-11-07&tz=UTC")).json() as Summary;
    expect(batches()).toBe(1);
    expect(s.code.seconds).toBe(0);
    expect(s.music).toMatchObject({ plays: 0, artists: [], tracks: [] });
    expect(s.places.places).toEqual([]);
    expect(s.reading.quote).toBeNull();
  });

  it("refuses bad periods in the app's error shape, and leaves /v1/wrapped/:year alone", async () => {
    const { get, env } = setup();
    for (const q of ["", "from=2026-11-01", "from=2026-11-30&to=2026-11-01", "from=2000-01-01&to=2026-01-01", "from=2026-11-01&to=2026-11-30&tz=Nowhere/Here"]) {
      const res = await get(q);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid");
    }
    const root = new Hono<{ Bindings: Env }>();
    root.route("/v1/wrapped/summary", wrappedSummaryRoute);
    root.route("/v1/wrapped", wrappedRoute);
    expect((await root.request("/v1/wrapped/abcd", {}, env)).status).toBe(400);
  });

  it("finds local midnight and offsets across daylight saving", () => {
    expect(startOfDay("2026-03-08", NY)).toBe("2026-03-08T05:00:00.000Z");
    expect(startOfDay("2026-03-09", NY)).toBe("2026-03-09T04:00:00.000Z");
    expect(startOfDay("2026-06-01", "Asia/Kolkata")).toBe("2026-05-31T18:30:00.000Z");
    expect(offsetMinutes(NY, "2026-07-01T12:00:00.000Z")).toBe(-240);
    expect(offsetMinutes("Asia/Kolkata", "2026-07-01T12:00:00.000Z")).toBe(330);
    expect(sportName("weightlifting_msk")).toBe("Weightlifting");
    expect(sportName("hiit")).toBe("HIIT");
    expect(sportName(null)).toBe("Activity");
  });
});
