import { Hono } from "hono";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { z } from "zod";
import {
  authSecurity,
  dateSchema,
  dateTimeSchema,
  okResponses,
  okSchema,
  openApiJsonRequestBody,
  openApiRegistry,
} from "../schemas/openapi";

// /v1/training: a simple plan of what to do and when. WHOOP tracks the effort.
const app = new Hono<{ Bindings: Env }>();

/**
 * One exercise in a routine. Reps can be a range (8–12), per side (split
 * squats), or a hold in seconds (plank 30–45 s) instead of reps.
 */
type Exercise = {
  name: string; sets: number; reps: number; reps_max?: number | null; per_side?: boolean;
  seconds?: number | null; seconds_max?: number | null; weight?: number | null; unit?: string; rest?: number; note?: string | null;
};
const str = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function cleanExercises(list: unknown): Exercise[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).flatMap((e: Record<string, unknown>) => {
    const name = str(e?.name);
    if (!name) return [];
    const clamp = (v: number | null, lo: number, hi: number) => (v === null ? null : Math.min(Math.max(Math.round(v), lo), hi));
    const reps = clamp(num(e.reps), 1, 200) ?? 10;
    const repsMax = clamp(num(e.reps_max), 1, 200);
    const seconds = clamp(num(e.seconds), 1, 3600);
    const secondsMax = clamp(num(e.seconds_max), 1, 3600);
    return [{
      name, sets: clamp(num(e.sets), 1, 20) ?? 3, reps,
      reps_max: repsMax !== null && repsMax > reps ? repsMax : null,
      per_side: e.per_side === true,
      seconds, seconds_max: seconds !== null && secondsMax !== null && secondsMax > seconds ? secondsMax : null,
      weight: num(e.weight), unit: str(e.unit, 8) ?? "kg", rest: clamp(num(e.rest), 0, 900) ?? 90,
      note: str(e.note, 200),
    }];
  });
}

export function cleanWeekdays(v: unknown): string {
  const days = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return [...new Set(days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort().join(",");
}

type RotationRoutine = { id: string; weekdays: number[]; exercises: unknown[] };

const dayNumber = (day: string) => Math.round(Date.parse(day + "T12:00:00Z") / 86_400_000);

/**
 * What's up today in a rotation (routines without weekdays, in order): the
 * workout after the last one you did. A routine with no exercises is a rest
 * day; it takes one calendar day and then passes. If you've already done
 * something today, today stays on that workout.
 */
export function nextInRotation(
  routines: RotationRoutine[], last: { day: string; routine_id: string } | null, today: string,
): { routine_id: string | null; state: "first" | "doing" | "next" | "rest" | "none" } {
  const rotation = routines.filter((r) => r.weekdays.length === 0);
  if (rotation.length === 0) return { routine_id: null, state: "none" };
  const isRest = (r: RotationRoutine) => r.exercises.length === 0;
  if (rotation.every(isRest)) return { routine_id: rotation[0].id, state: "rest" };
  const start = rotation.findIndex((r) => !isRest(r));
  const lastIndex = last ? rotation.findIndex((r) => r.id === last.routine_id) : -1;
  if (!last || lastIndex < 0) return { routine_id: rotation[start].id, state: "first" };
  if (last.day === today) return { routine_id: last.routine_id, state: "doing" };
  let gap = dayNumber(today) - dayNumber(last.day);   // days since the last workout (1 = yesterday)
  let i = (lastIndex + 1) % rotation.length;
  for (let guard = 0; guard < rotation.length && isRest(rotation[i]); guard++) {
    if (gap <= 1) return { routine_id: rotation[i].id, state: "rest" };
    gap -= 1;                                         // that rest day has passed
    i = (i + 1) % rotation.length;
  }
  return { routine_id: rotation[i].id, state: "next" };
}

/**
 * Today's workout once your own pick is counted: a set already ticked today
 * wins (you're doing it), else the day you picked, else the plan. The plan's
 * own answer stays in planned_routine_id so a client can offer "back to plan".
 */
export function withPick(
  planned: { routine_id: string | null; state: "first" | "doing" | "next" | "rest" | "none" },
  routines: RotationRoutine[], pick: string | null,
): { routine_id: string | null; state: "first" | "doing" | "next" | "rest" | "none"; picked: boolean; planned_routine_id: string | null } {
  const base = { ...planned, picked: false, planned_routine_id: planned.routine_id };
  if (planned.state === "doing" || !pick || pick === planned.routine_id) return base;
  const r = routines.find((x) => x.id === pick);
  if (!r) return base;
  return { routine_id: r.id, state: r.exercises.length === 0 ? "rest" : "next", picked: true, planned_routine_id: planned.routine_id };
}

const present = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, weekdays: String(r.weekdays || "").split(",").filter(Boolean).map(Number),
  exercises: JSON.parse(String(r.exercises_json || "[]")), position: r.position, updated_at: r.updated_at,
});

// OpenAPI registrations. Input here is cleaned rather than validated: bad
// values are clamped or dropped (see cleanExercises and cleanWeekdays).
const day = dateSchema.openapi({ example: "2026-11-24" });

const exerciseSchema = z.object({
  name: z.string().max(120),
  sets: z.number().int().min(1).max(20).openapi({ description: "Default 3" }),
  reps: z.number().int().min(1).max(200).openapi({ description: "Default 10" }),
  reps_max: z.number().int().nullable().optional().openapi({ description: "Top of a rep range (8–12)" }),
  per_side: z.boolean().optional(),
  seconds: z.number().int().min(1).max(3600).nullable().optional().openapi({ description: "A hold instead of reps" }),
  seconds_max: z.number().int().nullable().optional(),
  weight: z.number().nullable().optional(),
  unit: z.string().max(8).optional().openapi({ description: "Default kg" }),
  rest: z.number().int().min(0).max(900).optional().openapi({ description: "Seconds; default 90" }),
  note: z.string().max(200).nullable().optional(),
});

const routineSchema = z.object({
  id: z.string(),
  name: z.string(),
  weekdays: z.array(z.number().int().min(1).max(7)).openapi({ description: "Empty for a routine in the rotation" }),
  exercises: z.array(exerciseSchema).openapi({ description: "Empty for a rest day" }),
  position: z.number().int(),
  updated_at: dateTimeSchema,
});

const setRowSchema = z.object({
  id: z.number().int(),
  routine_id: z.string().nullable(),
  day,
  exercise: z.string(),
  set_number: z.number().int(),
  reps: z.number().int().nullable(),
  weight: z.number().nullable(),
  unit: z.string().nullable(),
  done_at: dateTimeSchema,
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/training/routines",
  summary: "List training routines",
  security: authSecurity,
  responses: okResponses(z.object({ routines: z.array(routineSchema) })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/training/next",
  summary: "Get today's workout in the rotation",
  security: authSecurity,
  request: { query: z.object({ today: day.openapi({ description: "The phone's local date" }) }) },
  responses: okResponses(z.object({
    routine_id: z.string().nullable(),
    state: z.enum(["first", "doing", "next", "rest", "none"]),
    picked: z.boolean().openapi({ description: "True when today is a day you picked instead of the plan" }),
    planned_routine_id: z.string().nullable().openapi({ description: "What the plan says, whatever you picked" }),
    last_day: day.nullable(),
    last_routine_id: z.string().nullable(),
  })),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/training/pick",
  summary: "Pick today's workout (or rest) instead of the plan",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      day: day.openapi({ description: "The phone's local date" }),
      routine_id: z.string().max(64).nullable().openapi({ description: "null puts the day back on the plan" }),
    })),
  },
  responses: okResponses(z.object({ ok: z.boolean(), day: day, routine_id: z.string().nullable() })),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/training/routines/{id}",
  summary: "Create or replace a routine",
  security: authSecurity,
  request: {
    params: z.object({ id: z.string().max(64) }),
    body: openApiJsonRequestBody(z.object({
      name: z.string().min(1).max(120),
      weekdays: z.union([z.array(z.number().int().min(1).max(7)), z.string()]).optional()
        .openapi({ description: "1 (Monday) to 7, as a list or comma-separated" }),
      exercises: z.array(exerciseSchema.partial().extend({ name: z.string() })).max(40).optional(),
      position: z.number().optional(),
    })),
  },
  responses: okResponses(routineSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/training/routines/{id}",
  summary: "Archive a routine (history keeps it)",
  security: authSecurity,
  request: { params: z.object({ id: z.string() }) },
  responses: okResponses(okSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/training/sets",
  summary: "Tick a set off (or update it)",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      routine_id: z.string().max(64).nullable().optional(),
      day,
      exercise: z.string().min(1).max(120),
      set_number: z.number(),
      reps: z.number().nullable().optional(),
      weight: z.number().nullable().optional(),
      unit: z.string().max(8).nullable().optional(),
    })),
  },
  responses: okResponses(okSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/training/sets",
  summary: "Untick one set",
  security: authSecurity,
  request: {
    query: z.object({
      day,
      exercise: z.string(),
      set_number: z.coerce.number().int(),
    }),
  },
  responses: okResponses(okSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/training/day",
  summary: "Get one day's ticked sets and the previous time each exercise was done",
  security: authSecurity,
  request: { query: z.object({ day }) },
  responses: okResponses(z.object({
    day,
    sets: z.array(setRowSchema),
    last: z.array(z.object({
      exercise: z.string(),
      day,
      set_number: z.number().int(),
      reps: z.number().int().nullable(),
      weight: z.number().nullable(),
      unit: z.string().nullable(),
    })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/training/history",
  summary: "List days you trained",
  security: authSecurity,
  request: {
    query: z.object({
      days: z.coerce.number().int().min(1).max(3650).optional().openapi({ description: "Default 90" }),
    }),
  },
  responses: okResponses(z.object({
    days: z.array(z.object({
      day,
      routine_id: z.string().nullable(),
      routine: z.string().nullable(),
      sets: z.number().int(),
      started_at: dateTimeSchema,
      ended_at: dateTimeSchema,
      volume: z.number().openapi({ description: "Sum of weight × reps" }),
    })),
  })),
});

app.get("/routines", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM training_routines WHERE archived = 0 ORDER BY position, created_at").all();
  return c.json({ routines: (results as Record<string, unknown>[]).map(present) });
});

/** Today's workout in the rotation. ?today=YYYY-MM-DD (the phone's local date) */
app.get("/next", async (c) => {
  const today = c.req.query("today");
  if (!isDay(today)) return c.json({ error: "today must look like 2026-11-24" }, 400);
  const { results } = await c.env.DB.prepare("SELECT * FROM training_routines WHERE archived = 0 ORDER BY position, created_at").all();
  const routines = (results as Record<string, unknown>[]).map(present) as unknown as RotationRoutine[];
  const last = await c.env.DB.prepare(
    "SELECT day, routine_id FROM training_sets WHERE routine_id IS NOT NULL AND day <= ? ORDER BY day DESC, done_at DESC LIMIT 1",
  ).bind(today).first<{ day: string; routine_id: string }>();
  const pick = await c.env.DB.prepare("SELECT routine_id FROM training_picks WHERE day = ?").bind(today).first<{ routine_id: string }>();
  const planned = nextInRotation(routines, last ?? null, today);
  return c.json({ ...withPick(planned, routines, pick?.routine_id ?? null), last_day: last?.day ?? null, last_routine_id: last?.routine_id ?? null });
});

/** Do another day today (or rest). { day, routine_id } — routine_id null goes back to the plan. */
app.put("/pick", async (c) => {
  const b = (await parseJson(c.req.raw)) as Record<string, unknown> | null;
  if (!b || !isDay(b.day)) return c.json({ error: "Send day (2026-11-24) and routine_id (or null for the plan)" }, 400);
  const id = str(b.routine_id, 64);
  if (id) {
    await c.env.DB.prepare(
      "INSERT INTO training_picks (day, routine_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET routine_id = excluded.routine_id, updated_at = excluded.updated_at",
    ).bind(b.day, id, new Date().toISOString()).run();
  } else {
    await c.env.DB.prepare("DELETE FROM training_picks WHERE day = ?").bind(b.day).run();
  }
  return c.json({ ok: true, day: b.day, routine_id: id ?? null });
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

/**
 * Days you trained, with the routine, how many sets, and when you started and
 * finished (the first and last set you ticked). ?days=90
 */
app.get("/history", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days")) || 90, 1), 3650);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT s.day, s.routine_id, r.name AS routine, COUNT(*) AS sets, MIN(s.done_at) AS started_at, MAX(s.done_at) AS ended_at,
            ROUND(SUM(COALESCE(s.weight, 0) * COALESCE(s.reps, 0))) AS volume FROM training_sets AS s
     LEFT JOIN training_routines AS r ON r.id = s.routine_id WHERE s.day >= ? GROUP BY s.day, s.routine_id ORDER BY s.day DESC`,
  ).bind(since).all();
  return c.json({ days: results });
});

export default app;
