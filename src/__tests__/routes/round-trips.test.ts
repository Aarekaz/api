import { describe, expect, it } from "vitest";
import type { Env } from "../../types/env";
import { testD1 } from "../helpers/d1";
import trainingRoute from "../../routes/training";
import { createMusicRoute } from "../../routes/music";

// Hot reads Today makes at launch: their independent queries go in one
// D1 batch (one round trip, ADR 0012), with the same replies as before.

function counted() {
  const d1 = testD1({ migrations: "all" });
  const calls = { batch: 0, single: 0 };
  const DB = d1.DB;
  const batch = DB.batch.bind(DB);
  const prepare = DB.prepare.bind(DB);
  let inBatch = false;
  DB.batch = (async (statements: Parameters<typeof batch>[0]) => {
    calls.batch++;
    inBatch = true;
    try { return await batch(statements); } finally { inBatch = false; }
  }) as typeof DB.batch;
  DB.prepare = ((sql: string) => {
    const statement = prepare(sql);
    const wrap = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, {
      get(target, key, receiver) {
        if (key === "first" || key === "all" || key === "run" || key === "raw") {
          return (...args: unknown[]) => { if (!inBatch) calls.single++; return (Reflect.get(target, key, receiver) as (...a: unknown[]) => unknown).apply(target, args); };
        }
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        return Reflect.get(target, key, receiver);
      },
    });
    return wrap(statement);
  }) as typeof DB.prepare;
  return { d1, env: { DB } as Env, calls };
}

describe("one round trip", () => {
  it("GET /v1/training/next reads routines, the last session and the pick together", async () => {
    const { d1, env, calls } = counted();
    const now = "2026-11-01T00:00:00Z";
    d1.db.prepare("INSERT INTO training_routines (id, name, exercises_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("a", "Push", JSON.stringify([{ name: "Bench" }]), 0, now, now);
    d1.db.prepare("INSERT INTO training_routines (id, name, exercises_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("b", "Pull", JSON.stringify([{ name: "Row" }]), 1, now, now);
    d1.db.prepare("INSERT INTO training_sets (routine_id, day, exercise, set_number, reps, done_at) VALUES ('a', '2026-11-20', 'Bench', 1, 5, ?)").run(now);
    const res = await trainingRoute.request("/next?today=2026-11-24", {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ routine_id: "b", state: "next", picked: false, last_day: "2026-11-20", last_routine_id: "a" });
    expect(calls).toEqual({ batch: 1, single: 0 });

    d1.db.prepare("INSERT INTO training_picks (day, routine_id, updated_at) VALUES ('2026-11-24', 'a', ?)").run(now);
    const picked = await (await trainingRoute.request("/next?today=2026-11-24", {}, env)).json() as Record<string, unknown>;
    expect(picked).toMatchObject({ routine_id: "a", picked: true, planned_routine_id: "b" });
  });

  it("GET /v1/training/day reads the day and the last sets together", async () => {
    const { d1, env, calls } = counted();
    const now = "2026-11-01T00:00:00Z";
    d1.db.prepare("INSERT INTO training_sets (day, exercise, set_number, reps, done_at) VALUES ('2026-11-20', 'Bench', 1, 5, ?)").run(now);
    d1.db.prepare("INSERT INTO training_sets (day, exercise, set_number, reps, done_at) VALUES ('2026-11-24', 'Bench', 1, 6, ?)").run(now);
    const body = await (await trainingRoute.request("/day?day=2026-11-24", {}, env)).json() as { sets: Array<{ reps: number }>; last: Array<{ reps: number; day: string }> };
    expect(body.sets.map((s) => s.reps)).toEqual([6]);
    expect(body.last).toEqual([{ exercise: "Bench", day: "2026-11-20", set_number: 1, reps: 5, weight: null, unit: null }]);
    expect(calls).toEqual({ batch: 1, single: 0 });
  });

  it("GET /v1/music/history reads the page and the total together", async () => {
    const { d1, env, calls } = counted();
    for (const [i, at] of ["2026-11-20T10:00:00Z", "2026-11-21T10:00:00Z"].entries()) {
      d1.db.prepare("INSERT INTO music_plays (played_at, track_id, track, artists, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(at, `t${i}`, `Song ${i}`, "Band", 1000, at);
    }
    const route = createMusicRoute();
    const body = await (await route.request("/history?limit=1", {}, env)).json() as { items: Array<{ track: string }>; total: { n: number; since: string }; next_cursor: string | null };
    expect(body.items.map((p) => p.track)).toEqual(["Song 1"]);
    expect(body.total).toEqual({ n: 2, since: "2026-11-20T10:00:00Z" });
    expect(body.next_cursor).toBeTruthy();
    expect(calls).toEqual({ batch: 1, single: 0 });
  });
});
