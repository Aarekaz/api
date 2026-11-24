import { Hono } from "hono";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";

// /v1/training: a simple plan of what to do and when. WHOOP tracks the effort.
const app = new Hono<{ Bindings: Env }>();

type Exercise = { name: string; sets: number; reps: number; weight?: number | null; unit?: string; rest?: number };
const str = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function cleanExercises(list: unknown): Exercise[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).flatMap((e: Record<string, unknown>) => {
    const name = str(e?.name);
    if (!name) return [];
    return [{
      name, sets: Math.min(Math.max(Math.round(num(e.sets) ?? 3), 1), 20), reps: Math.min(Math.max(Math.round(num(e.reps) ?? 10), 1), 200),
      weight: num(e.weight), unit: str(e.unit, 8) ?? "kg", rest: Math.min(Math.max(Math.round(num(e.rest) ?? 90), 0), 900),
    }];
  });
}

export function cleanWeekdays(v: unknown): string {
  const days = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return [...new Set(days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort().join(",");
}

const present = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, weekdays: String(r.weekdays || "").split(",").filter(Boolean).map(Number),
  exercises: JSON.parse(String(r.exercises_json || "[]")), position: r.position, updated_at: r.updated_at,
});

app.get("/routines", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM training_routines WHERE archived = 0 ORDER BY position, created_at").all();
  return c.json({ routines: (results as Record<string, unknown>[]).map(present) });
});

/** Create or replace a routine. { id?, name, weekdays: [1..7], exercises: [...] } */
app.put("/routines/:id", async (c) => {
  const body = (await parseJson(c.req.raw)) as Record<string, unknown> | null;
  const name = str(body?.name);
  if (!body || !name) return c.json({ error: "A routine needs a name" }, 400);
  const id = c.req.param("id").slice(0, 64);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO training_routines (id, name, weekdays, exercises_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, weekdays = excluded.weekdays, exercises_json = excluded.exercises_json,
       position = excluded.position, archived = 0, updated_at = excluded.updated_at`,
  ).bind(id, name, cleanWeekdays(body.weekdays), JSON.stringify(cleanExercises(body.exercises)), Math.round(num(body.position) ?? 0), now, now).run();
  const row = await c.env.DB.prepare("SELECT * FROM training_routines WHERE id = ?").bind(id).first();
  return c.json(present(row as Record<string, unknown>));
});

/** Archive (not delete): history keeps its routine. */
app.delete("/routines/:id", async (c) => {
  await c.env.DB.prepare("UPDATE training_routines SET archived = 1, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Tick a set off (or update it). { routine_id, day, exercise, set_number, reps, weight, unit } */
app.post("/sets", async (c) => {
  const b = (await parseJson(c.req.raw)) as Record<string, unknown> | null;
  const exercise = str(b?.exercise);
  const set = num(b?.set_number);
  if (!b || !exercise || !isDay(b.day) || set === null) return c.json({ error: "Send day, exercise and set_number" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO training_sets (routine_id, day, exercise, set_number, reps, weight, unit, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, exercise, set_number) DO UPDATE SET reps = excluded.reps, weight = excluded.weight, unit = excluded.unit, done_at = excluded.done_at`,
  ).bind(str(b.routine_id, 64), b.day, exercise, Math.round(set), num(b.reps), num(b.weight), str(b.unit, 8), new Date().toISOString()).run();
  return c.json({ ok: true });
});

/** Untick a set. ?day=&exercise=&set_number= (only that one row) */
app.delete("/sets", async (c) => {
  const day = c.req.query("day"), exercise = c.req.query("exercise"), set = Number(c.req.query("set_number"));
  if (!isDay(day) || !exercise || !Number.isInteger(set)) return c.json({ error: "Send day, exercise and set_number" }, 400);
  await c.env.DB.prepare("DELETE FROM training_sets WHERE day = ? AND exercise = ? AND set_number = ?").bind(day, exercise, set).run();
  return c.json({ ok: true });
});

/** One day's ticked sets, plus the last time each of those exercises was done before it. ?day= */
app.get("/day", async (c) => {
  const day = c.req.query("day");
  if (!isDay(day)) return c.json({ error: "day must look like 2026-11-24" }, 400);
  const sets = await c.env.DB.prepare("SELECT * FROM training_sets WHERE day = ? ORDER BY exercise, set_number").bind(day).all();
  const last = await c.env.DB.prepare(
    `SELECT s.exercise, s.day, s.set_number, s.reps, s.weight, s.unit FROM training_sets AS s
     JOIN (SELECT exercise, MAX(day) AS day FROM training_sets WHERE day < ? GROUP BY exercise) AS l
       ON l.exercise = s.exercise AND l.day = s.day ORDER BY s.exercise, s.set_number`,
  ).bind(day).all();
  return c.json({ day, sets: sets.results, last: last.results });
});

/** Days you trained, with the routine and how many sets. ?days=90 */
app.get("/history", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days")) || 90, 1), 3650);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT s.day, s.routine_id, r.name AS routine, COUNT(*) AS sets FROM training_sets AS s
     LEFT JOIN training_routines AS r ON r.id = s.routine_id WHERE s.day >= ? GROUP BY s.day, s.routine_id ORDER BY s.day DESC`,
  ).bind(since).all();
  return c.json({ days: results });
});

export default app;
