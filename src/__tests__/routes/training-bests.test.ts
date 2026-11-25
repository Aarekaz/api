import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { testD1 } from "../helpers/d1";
import type { Env } from "../../types/env";
import trainingRoute from "../../routes/training";

type Set = { day: string; exercise: string; set_number: number; reps: number | null; weight: number | null; unit: string | null };

function setup(sets: Set[]) {
  const { db, DB, queries } = testD1({ migrations: ["0031_training"] });
  const insert = db.prepare("INSERT INTO training_sets (day, exercise, set_number, reps, weight, unit, done_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const s of sets) insert.run(s.day, s.exercise, s.set_number, s.reps, s.weight, s.unit, `${s.day}T12:00:00Z`);
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/training", trainingRoute);
  const get = (path: string) => root.request(path, {}, { DB } as Env);
  return { get, queries };
}

type Best = Set & { kilograms: number };
const bests = async (get: (p: string) => Response | Promise<Response>, path = "/v1/training/bests") =>
  (await (await get(path)).json()) as { bests?: Best[]; items: Best[]; next_cursor: null };

/** TrainingLog.best(of:) from the app (Sources/OSCore/TrainingLog.swift), line for line. */
function appBest(sets: Set[]) {
  const kg = (s: Set) => (s.weight == null ? 0 : s.unit?.toLowerCase() === "lb" ? s.weight * 0.45359237 : s.weight);
  let best: { kilograms: number; reps: number; set: Set } | null = null;
  for (const s of sets) {
    if (!((s.reps ?? 0) > 0 || kg(s) > 0)) continue;
    if (best) {
      const w = kg(s), r = s.reps ?? 0;
      const beaten = w > best.kilograms + 0.1 || (Math.abs(w - best.kilograms) <= 0.1 && r > best.reps);
      if (!beaten) continue;
    }
    best = { kilograms: kg(s), reps: s.reps ?? 0, set: s };
  }
  return best;
}

const set = (day: string, exercise: string, set_number: number, reps: number | null, weight: number | null, unit: string | null = "kg"): Set =>
  ({ day, exercise, set_number, reps, weight, unit });

describe("GET /v1/training/bests", () => {
  it("is the heaviest set, the most reps breaking a tie, with its day and set", async () => {
    const { get } = setup([
      set("2026-11-01", "Squat", 1, 5, 100),
      set("2026-11-01", "Squat", 2, 3, 105),
      set("2026-11-08", "Squat", 1, 4, 105),
      set("2026-11-08", "Squat", 2, 12, 80),
    ]);
    const body = await bests(get);
    expect(body.items).toEqual([{ exercise: "Squat", day: "2026-11-08", set_number: 1, reps: 4, weight: 105, unit: "kg", kilograms: 105 }]);
    expect(body.bests).toBeUndefined();
    expect(body.next_cursor).toBeNull();
  });

  it("compares pounds in kilograms", async () => {
    const { get } = setup([
      set("2026-11-01", "Bench", 1, 5, 100, "kg"),
      set("2026-11-02", "Bench", 1, 5, 225, "lb"),   // 102.06 kg
      set("2026-11-03", "Row", 1, 8, 60, "kg"),
      set("2026-11-04", "Row", 1, 8, 130, "LB"),     // 58.97 kg
    ]);
    const body = await bests(get);
    expect(body.items.map((b) => [b.exercise, b.day, b.weight, b.unit])).toEqual([["Bench", "2026-11-02", 225, "lb"], ["Row", "2026-11-03", 60, "kg"]]);
    expect(body.items[0].kilograms).toBeCloseTo(102.0583, 3);
  });

  it("counts within 0.1 kg as the same weight, keeps the first of equal sets, and a move with no weight by its reps", async () => {
    const { get } = setup([
      set("2026-11-01", "Curl", 1, 10, 12.5, "kg"),
      set("2026-11-02", "Curl", 1, 10, 27.5, "lb"),  // 12.47 kg: the same weight, no more reps
      set("2026-11-03", "Curl", 1, 11, 27.5, "lb"),  // the same weight, more reps: a best
      set("2026-11-01", "Plank", 1, 45, null, null),
      set("2026-11-02", "Plank", 1, 60, null, null),
      set("2026-11-03", "Plank", 1, 60, null, null),
      set("2026-11-01", "Nothing", 1, null, null, null),
      set("2026-11-01", "Nothing", 2, 0, 0, "kg"),
    ]);
    const body = await bests(get);
    expect(body.items.map((b) => [b.exercise, b.day, b.reps])).toEqual([["Curl", "2026-11-03", 11], ["Plank", "2026-11-02", 60]]);
  });

  it("?before= counts only the days before it", async () => {
    const { get } = setup([set("2026-11-01", "Squat", 1, 5, 100), set("2026-11-24", "Squat", 1, 5, 110), set("2026-11-25", "Squat", 1, 5, 120)]);
    expect((await bests(get, "/v1/training/bests?before=2026-11-24")).items.map((b) => b.weight)).toEqual([100]);
    expect((await bests(get, "/v1/training/bests?before=2026-11-25")).items.map((b) => b.weight)).toEqual([110]);
    expect((await bests(get, "/v1/training/bests?before=2026-11-01")).items).toEqual([]);
    const bad = await get("/v1/training/bests?before=yesterday");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "invalid", message: "before must look like 2026-11-24" } });
  });

  it("agrees with the app's rule on a year of random sets, in one query", async () => {
    const exercises = ["Squat", "Bench", "Row", "Curl", "Plank"];
    const sets: Set[] = [];
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let d = 0; d < 365; d++) {
      const day = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
      for (const exercise of exercises) {
        if (rand(3)) continue;
        for (let n = 1; n <= 4; n++) {
          const lb = rand(4) === 0;
          const weight = exercise === "Plank" ? null : lb ? 2.5 * (10 + rand(30)) : 1.25 * (8 + rand(50));
          sets.push(set(day, exercise, n, rand(10) === 0 ? null : 1 + rand(12), weight, weight === null ? null : lb ? "lb" : "kg"));
        }
      }
    }
    const { get, queries } = setup(sets);
    const before = "2026-09-01";
    const body = await bests(get, `/v1/training/bests?before=${before}`);
    expect(queries).toHaveLength(1);
    for (const exercise of exercises) {
      const mine = sets.filter((s) => s.exercise === exercise && s.day < before)
        .sort((a, b) => a.day.localeCompare(b.day) || a.set_number - b.set_number);
      const want = appBest(mine)!;
      const got = body.items.find((b) => b.exercise === exercise)!;
      expect([got.day, got.set_number]).toEqual([want.set.day, want.set.set_number]);
    }
  });
});
