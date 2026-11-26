import { describe, expect, it } from "vitest";
import { WhoopHealthReadRepository } from "../../services/whoop/read-repository";
import { testD1, type TestD1 } from "../helpers/d1";

// The collection reads used to compare julianday(time) numbers. They now
// compare the ISO text of the instant so migration 0053's indexes can serve
// them. This pins that every page, in every window, comes back exactly as the
// julianday() query returned it, including rows stored with an offset, without
// milliseconds or with a space, equal instants written differently, and the
// fallback to upstream_created_at when start_at is missing.

const USER = 42;

// Times around a DST change, a year boundary, the date line and +05:45; the
// 07:00Z group is one instant written five ways.
const TIMES: Array<string | null> = [
  "2026-03-08T06:59:59.999Z",
  "2026-03-08T07:00:00.000Z",
  "2026-03-08T02:00:00.000-05:00",
  "2026-03-08T12:45:00.000+05:45",
  "2026-03-08T07:00:00Z",
  "2026-03-08 07:00:00",
  "2026-03-08T07:00:00.001Z",
  "2026-06-15T12:00:00.000+14:00",
  "2026-06-14T12:00:00.000-12:00",
  "2026-06-15T00:00:00.0004Z",
  "2026-12-31T23:59:59.999Z",
  "2026-12-31T19:00:00.000-05:00",
  "2027-01-01T00:00:00.000Z",
  null,
];

// Bounds as the route binds them (Date.toISOString of what the client sent,
// whatever its offset) plus raw ones, in case a caller skips that step.
const BOUNDS: Array<string | null> = [
  null,
  "2026-03-08T07:00:00.000Z",
  new Date("2026-03-08T02:00:00.000-05:00").toISOString(),
  "2026-03-08T06:59:59.999Z",
  new Date("2026-06-15T00:00:00.000+00:00").toISOString(),
  new Date("2027-01-01T05:45:00+05:45").toISOString(),
  "2026-03-08T12:45:00+05:45",
  "2026-03-08 07:00:00",
];

interface Collection {
  table: string;
  key: string;
  time: string;
  list: (repository: WhoopHealthReadRepository, options: Options) => Promise<{
    records: Array<Record<string, unknown>>;
    nextAnchor: { sortAt: string; id: string } | null;
  }>;
  insert: (db: TestD1["db"], id: number, time: string | null, created: string, user: number, deleted: string | null) => void;
}

interface Options {
  start: string | null;
  end: string | null;
  limit: number;
  cursor: { sortAt: string; id: string } | null;
}

const workoutId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const COLLECTIONS: Collection[] = [
  {
    table: "whoop_cycles",
    key: "cycle_id",
    time: "start_at",
    list: (r, o) => r.listCycles(USER, o) as never,
    insert: (db, id, time, created, user, deleted) => db.prepare(`
      INSERT INTO whoop_cycles (cycle_id, whoop_user_id, start_at, score_state, upstream_created_at,
        upstream_updated_at, deleted_at, synced_at, raw_json)
      VALUES (?, ?, ?, 'SCORED', ?, ?, ?, ?, '{}')
    `).run(id, user, time ?? created, created, created, deleted, created),
  },
  {
    table: "whoop_recoveries",
    key: "sleep_id",
    time: "upstream_created_at",
    list: (r, o) => r.listRecoveries(USER, o) as never,
    insert: (db, id, time, created, user, deleted) => db.prepare(`
      INSERT INTO whoop_recoveries (sleep_id, cycle_id, whoop_user_id, score_state, upstream_created_at,
        upstream_updated_at, deleted_at, synced_at, raw_json)
      VALUES (?, ?, ?, 'SCORED', ?, ?, ?, ?, '{}')
    `).run(workoutId(id), id, user, time ?? created, created, deleted, created),
  },
  {
    table: "whoop_sleeps",
    key: "sleep_id",
    time: "COALESCE(start_at, upstream_created_at)",
    list: (r, o) => r.listSleeps(USER, o) as never,
    insert: (db, id, time, created, user, deleted) => db.prepare(`
      INSERT INTO whoop_sleeps (sleep_id, cycle_id, whoop_user_id, start_at, score_state, upstream_created_at,
        upstream_updated_at, deleted_at, synced_at, raw_json)
      VALUES (?, ?, ?, ?, 'SCORED', ?, ?, ?, ?, '{}')
    `).run(workoutId(id), id, user, time, created, created, deleted, created),
  },
  {
    table: "whoop_workouts",
    key: "workout_id",
    time: "COALESCE(start_at, upstream_created_at)",
    list: (r, o) => r.listWorkouts(USER, o) as never,
    insert: (db, id, time, created, user, deleted) => db.prepare(`
      INSERT INTO whoop_workouts (workout_id, whoop_user_id, start_at, score_state, upstream_created_at,
        upstream_updated_at, deleted_at, synced_at, raw_json)
      VALUES (?, ?, ?, 'SCORED', ?, ?, ?, ?, '{}')
    `).run(workoutId(id), user, time, created, created, deleted, created),
  },
];

// The query as it was before 0053, verbatim apart from the column list.
const julianPage = (db: TestD1["db"], c: Collection, o: Options) => {
  const instant = `julianday(${c.time})`;
  const filters = ["whoop_user_id = ?", "deleted_at IS NULL"];
  const bindings: unknown[] = [USER];
  if (o.start !== null) { filters.push(`${instant} >= julianday(?)`); bindings.push(o.start); }
  if (o.end !== null) { filters.push(`${instant} <= julianday(?)`); bindings.push(o.end); }
  if (o.cursor !== null) {
    filters.push(`(${instant} < julianday(?) OR (${instant} = julianday(?) AND ${c.key} < ?))`);
    bindings.push(o.cursor.sortAt, o.cursor.sortAt, c.key === "cycle_id" ? Number(o.cursor.id) : o.cursor.id);
  }
  bindings.push(o.limit + 1);
  const rows = db.prepare(`
    SELECT ${c.key} AS id, strftime('%Y-%m-%dT%H:%M:%fZ', ${c.time}) AS sort_at
    FROM ${c.table} WHERE ${filters.join(" AND ")}
    ORDER BY ${instant} DESC, ${c.key} DESC LIMIT ?
  `).all(...bindings) as Array<{ id: unknown; sort_at: string }>;
  const page = rows.slice(0, o.limit);
  const last = page.at(-1);
  return {
    ids: page.map((row) => String(row.id)),
    nextAnchor: rows.length > o.limit && last ? { sortAt: last.sort_at, id: String(last.id) } : null,
  };
};

const seeded = (c: Collection) => {
  const d1 = testD1({ migrations: "all" });
  TIMES.forEach((time, i) => {
    // Several rows per time so ties at one instant are broken by the key.
    for (let copy = 0; copy < 2; copy += 1) {
      c.insert(d1.db, 100 + i * 10 + copy, time, "2026-05-01T09:30:00.000+02:00", USER, null);
    }
    c.insert(d1.db, 500 + i, time, "2026-05-01T07:30:00.000Z", USER, "2026-11-01T00:00:00.000Z");
    c.insert(d1.db, 700 + i, time, "2026-05-01T07:30:00.000Z", 7, null);
  });
  return d1;
};

describe("WHOOP collection order (0053)", () => {
  it.each(COLLECTIONS.map((c) => [c.table, c] as const))("%s pages exactly as the julianday() read did", async (_, c) => {
    const d1 = seeded(c);
    const repository = new WhoopHealthReadRepository(d1.DB);
    let pages = 0;
    for (const start of BOUNDS) {
      for (const end of BOUNDS) {
        for (const limit of [1, 3, 100]) {
          let cursor: Options["cursor"] = null;
          do {
            const options = { start, end, limit, cursor };
            const expected = julianPage(d1.db, c, options);
            const actual = await c.list(repository, options);
            const ids = actual.records.map((record) => String(record[c.key === "workout_id" ? "workout_id" : c.key]));
            expect({ start, end, limit, cursor, ids, next: actual.nextAnchor })
              .toEqual({ start, end, limit, cursor, ids: expected.ids, next: expected.nextAnchor });
            cursor = actual.nextAnchor;
            pages += 1;
          } while (cursor);
        }
      }
    }
    expect(pages).toBeGreaterThan(BOUNDS.length ** 2 * 3);
    d1.db.close();
  });

  it.each(COLLECTIONS.map((c) => [c.table, c] as const))("%s seeks its index in order", async (_, c) => {
    const d1 = testD1({ migrations: "all" });
    await c.list(new WhoopHealthReadRepository(d1.DB), {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-12-31T00:00:00.000Z",
      limit: 25,
      cursor: { sortAt: "2026-06-01T00:00:00.000Z", id: "1" },
    });
    const sql = d1.queries.at(-1)!;
    const bindings = Array.from(sql.matchAll(/\?/g), () => "1");
    const plan = (d1.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>)
      .map((row) => row.detail).join(" | ");
    expect(plan).toMatch(new RegExp(`^SEARCH ${c.table} USING INDEX idx_${c.table}_read \\(whoop_user_id=\\? AND <expr>>\\? AND <expr><\\?\\)$`));
    d1.db.close();
  });
});
