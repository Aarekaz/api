import { Hono } from "hono";
import type { Env } from "../types/env";
import { parseJsonAs } from "../utils/json";
import { fail, list } from "../lib/http";
import { isDay } from "../utils/date";
import { z } from "zod";
import {
  authSecurity,
  dateSchema,
  dateTimeSchema,
  structuredOkResponses,
  okSchema,
  openApiJsonRequestBody,
  openApiRegistry,
  pageFields,
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

// Bodies are forgiving on purpose: a field of the wrong type is dropped (text
// is trimmed and cut to length), and only the fields a write can't do without
// fail it, each route with its one message.
const text = (max = 120) => z.unknown().transform((v) => str(v, max));
const number = z.unknown().transform(num);
const isSet = <T>(v: T | null): v is T => v !== null;
const Day = z.custom<string>(isDay);

const PickBody = z.object({ day: Day, routine_id: text(64) });
const RoutineBody = z.object({
  name: text().refine(isSet),
  weekdays: z.unknown().transform(cleanWeekdays),
  exercises: z.unknown().transform((v) => cleanExercises(v)),
  position: number,
});
const SetBody = z.object({
  day: Day,
  exercise: text().refine(isSet),
  set_number: number.refine(isSet),
  routine_id: text(64),
  reps: number,
  weight: number,
  unit: text(8),
});

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
  responses: structuredOkResponses(z.object({ routines: z.array(routineSchema) })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/training/next",
  summary: "Get today's workout in the rotation",
  security: authSecurity,
  request: { query: z.object({ today: day.openapi({ description: "The phone's local date" }) }) },
  responses: structuredOkResponses(z.object({
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
  responses: structuredOkResponses(z.object({ ok: z.boolean(), day: day, routine_id: z.string().nullable() })),
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
  responses: structuredOkResponses(routineSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/training/routines/{id}",
  summary: "Archive a routine (history keeps it)",
  security: authSecurity,
  request: { params: z.object({ id: z.string() }) },
  responses: structuredOkResponses(okSchema),
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
  responses: structuredOkResponses(okSchema),
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
  responses: structuredOkResponses(okSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/training/day",
  summary: "Get one day's ticked sets and the previous time each exercise was done",
  security: authSecurity,
  request: { query: z.object({ day }) },
  responses: structuredOkResponses(z.object({
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

const bestSchema = z.object({
  exercise: z.string(),
  day,
  set_number: z.number().int(),
  reps: z.number().int().nullable(),
  weight: z.number().nullable(),
  unit: z.string().nullable(),
  kilograms: z.number().openapi({ description: "The weight in kg (lb × 0.45359237), what bests are compared by" }),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/training/bests",
  summary: "Get your best set at each exercise",
  description: "The heaviest set (in kg), and the most reps at that weight; within 0.1 kg counts as the same weight. "
    + "Equal sets: the first one you did. A move with no weight is its most reps.",
  security: authSecurity,
  request: { query: z.object({ before: day.optional().openapi({ description: "Only sets on days before this one" }) }) },
  responses: structuredOkResponses(z.object({
    bests: z.array(bestSchema).optional().openapi({ deprecated: true, description: "Deprecated: same as items, sent only while LEGACY_LIST_KEYS is on" }),
    ...pageFields(bestSchema),
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
  responses: structuredOkResponses(z.object({
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
  if (!isDay(today)) return fail(c, 400, "today must look like 2026-11-24");
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
  const parsed = await parseJsonAs(c.req.raw, PickBody);
  if (!parsed.success) return fail(c, 400, "Send day (2026-11-24) and routine_id (or null for the plan)");
  const b = parsed.data;
  const id = b.routine_id;
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
  const parsed = await parseJsonAs(c.req.raw, RoutineBody);
  if (!parsed.success) return fail(c, 400, "A routine needs a name");
  const { name, ...body } = parsed.data;
  const id = c.req.param("id").slice(0, 64);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO training_routines (id, name, weekdays, exercises_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, weekdays = excluded.weekdays, exercises_json = excluded.exercises_json,
       position = excluded.position, archived = 0, updated_at = excluded.updated_at`,
  ).bind(id, name, body.weekdays, JSON.stringify(body.exercises), Math.round(body.position ?? 0), now, now).run();
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
  const parsed = await parseJsonAs(c.req.raw, SetBody);
  if (!parsed.success) return fail(c, 400, "Send day, exercise and set_number");
  const { exercise, set_number: set, ...b } = parsed.data;
  await c.env.DB.prepare(
    `INSERT INTO training_sets (routine_id, day, exercise, set_number, reps, weight, unit, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, exercise, set_number) DO UPDATE SET reps = excluded.reps, weight = excluded.weight, unit = excluded.unit, done_at = excluded.done_at`,
  ).bind(b.routine_id, b.day, exercise, Math.round(set), b.reps, b.weight, b.unit, new Date().toISOString()).run();
  return c.json({ ok: true });
});

/** Untick a set. ?day=&exercise=&set_number= (only that one row) */
app.delete("/sets", async (c) => {
  const day = c.req.query("day"), exercise = c.req.query("exercise"), set = Number(c.req.query("set_number"));
  if (!isDay(day) || !exercise || !Number.isInteger(set)) return fail(c, 400, "Send day, exercise and set_number");
  await c.env.DB.prepare("DELETE FROM training_sets WHERE day = ? AND exercise = ? AND set_number = ?").bind(day, exercise, set).run();
  return c.json({ ok: true });
});

/** One day's ticked sets, plus the last time each of those exercises was done before it. ?day= */
app.get("/day", async (c) => {
  const day = c.req.query("day");
  if (!isDay(day)) return fail(c, 400, "day must look like 2026-11-24");
  const sets = await c.env.DB.prepare("SELECT * FROM training_sets WHERE day = ? ORDER BY exercise, set_number").bind(day).all();
  const last = await c.env.DB.prepare(
    `SELECT s.exercise, s.day, s.set_number, s.reps, s.weight, s.unit FROM training_sets AS s
     JOIN (SELECT exercise, MAX(day) AS day FROM training_sets WHERE day < ? GROUP BY exercise) AS l
       ON l.exercise = s.exercise AND l.day = s.day ORDER BY s.exercise, s.set_number`,
  ).bind(day).all();
  return c.json({ day, sets: sets.results, last: last.results });
});

/**
 * Your best set at each exercise, in one query: the rule the app's
 * TrainingLog.best(of:) applies (Sources/OSCore/TrainingLog.swift). Weights
 * compare in kg (lb × 0.45359237; no weight is 0). A set counts if it has reps
 * or weight. The best is the heaviest; within 0.1 kg (plates are 1.25 kg apart)
 * it's the same weight, and more reps win. Among equal sets the first one you
 * did stays, as the app keeps the first when nothing beats it.
 * ?before=YYYY-MM-DD counts only days before it.
 */
export const BESTS_SQL = `
  WITH sets AS (
    SELECT exercise, day, set_number, reps, weight, unit,
           COALESCE(weight, 0) * (CASE WHEN LOWER(unit) = 'lb' THEN 0.45359237 ELSE 1 END) AS kilograms,
           COALESCE(reps, 0) AS n
      FROM training_sets WHERE (?1 IS NULL OR day < ?1)
  ), counted AS (
    SELECT *, MAX(kilograms) OVER (PARTITION BY exercise) AS heaviest FROM sets WHERE n > 0 OR kilograms > 0
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY exercise ORDER BY n DESC, day, set_number) AS place
      FROM counted WHERE kilograms >= heaviest - 0.1
  )
  SELECT exercise, day, set_number, reps, weight, unit, kilograms FROM ranked WHERE place = 1 ORDER BY exercise`;

app.get("/bests", async (c) => {
  const before = c.req.query("before");
  if (before !== undefined && !isDay(before)) return fail(c, 400, "before must look like 2026-11-24");
  const { results } = await c.env.DB.prepare(BESTS_SQL).bind(before ?? null).all();
  return list(c, "bests", results, null);
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
