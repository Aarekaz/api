import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody, validateQuery } from "../utils/validation";
import {
  normalizeCustomExercise,
  normalizeCustomWorkoutTemplate,
  normalizeCustomWorkoutSchedule,
  normalizeCustomWorkoutSet,
} from "../utils/normalizers";
import {
  customExerciseInputSchema,
  customExerciseSchema,
  customWorkoutTemplateInputSchema,
  customWorkoutTemplateSchema,
  customWorkoutScheduleInputSchema,
  customWorkoutScheduleSchema,
  customWorkoutSessionInputSchema,
  customWorkoutSessionSchema,
  workoutSetInputSchema,
  workoutSetPatchSchema,
  workoutSetSchema,
  customExercisesQuerySchema,
  customWorkoutTemplatesQuerySchema,
  customWorkoutSchedulesQuerySchema,
  customWorkoutSessionsQuerySchema,
} from "../schemas/custom";
import {
  openApiRegistry,
  okUpdatedSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

const okCreatedWithIdSchema = z.object({
  ok: z.boolean(),
  id: z.number(),
  created_at: z.string(),
});

const okDeletedSchema = z.object({
  ok: z.boolean(),
  deleted_at: z.string(),
});

const workoutSessionsListSchema = z.object({
  start: z.string(),
  end: z.string(),
  count: z.number(),
  sessions: z.array(customWorkoutSessionSchema),
});

const workoutSetsListSchema = z.object({
  count: z.number(),
  sets: z.array(workoutSetSchema),
});

const parseId = (value: string): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/custom/exercises",
  summary: "List custom exercises",
  security: authSecurity,
  request: { query: customExercisesQuerySchema },
  responses: okResponses(z.array(customExerciseSchema)),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/custom/exercises",
  summary: "Create custom exercise",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(customExerciseInputSchema) },
  responses: createdResponses(okCreatedWithIdSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/custom/exercises/{id}",
  summary: "Get custom exercise",
  security: authSecurity,
  responses: okResponses(customExerciseSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/custom/exercises/{id}",
  summary: "Update custom exercise",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(customExerciseInputSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/custom/exercises/{id}",
  summary: "Delete custom exercise",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/custom/workout-templates",
  summary: "List workout templates",
  security: authSecurity,
  request: { query: customWorkoutTemplatesQuerySchema },
  responses: okResponses(z.array(customWorkoutTemplateSchema)),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/custom/workout-templates",
  summary: "Create workout template",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(customWorkoutTemplateInputSchema) },
  responses: createdResponses(okCreatedWithIdSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/custom/workout-templates/{id}",
  summary: "Get workout template",
  security: authSecurity,
  responses: okResponses(customWorkoutTemplateSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/custom/workout-templates/{id}",
  summary: "Update workout template",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(customWorkoutTemplateInputSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/custom/workout-templates/{id}",
  summary: "Delete workout template",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/custom/workout-schedules",
  summary: "List workout schedules",
  security: authSecurity,
  request: { query: customWorkoutSchedulesQuerySchema },
  responses: okResponses(z.array(customWorkoutScheduleSchema)),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/custom/workout-schedules",
  summary: "Create workout schedule",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(customWorkoutScheduleInputSchema) },
  responses: createdResponses(okCreatedWithIdSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/custom/workout-schedules/{id}",
  summary: "Get workout schedule",
  security: authSecurity,
  responses: okResponses(customWorkoutScheduleSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/custom/workout-schedules/{id}",
  summary: "Update workout schedule",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(customWorkoutScheduleInputSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/custom/workout-schedules/{id}",
  summary: "Delete workout schedule",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/custom/workout-sessions",
  summary: "List workout sessions",
  security: authSecurity,
  request: { query: customWorkoutSessionsQuerySchema },
  responses: okResponses(workoutSessionsListSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/custom/workout-sessions",
  summary: "Create workout session",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(customWorkoutSessionInputSchema) },
  responses: createdResponses(okCreatedWithIdSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/custom/workout-sessions/{id}",
  summary: "Get workout session",
  security: authSecurity,
  responses: okResponses(customWorkoutSessionSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/custom/workout-sessions/{id}",
  summary: "Update workout session",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(customWorkoutSessionInputSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/custom/workout-sessions/{id}",
  summary: "Delete workout session",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/custom/workout-sessions/{id}/sets",
  summary: "List workout sets",
  security: authSecurity,
  responses: okResponses(workoutSetsListSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/custom/workout-sessions/{id}/sets",
  summary: "Create workout set",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(workoutSetInputSchema) },
  responses: createdResponses(okCreatedWithIdSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/custom/workout-sessions/{id}/sets/{set_id}",
  summary: "Update workout set",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(workoutSetPatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/custom/workout-sessions/{id}/sets/{set_id}",
  summary: "Delete workout set",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/exercises", async (c) => {
  const query = c.req.query();
  const validation = validateQuery(customExercisesQuerySchema, query);
  if (!validation.ok) {
    return validation.response;
  }

  const q = validation.data.q?.trim();
  const limit = Math.min(Number(validation.data.limit) || 100, 500);
  const offset = Math.max(Number(validation.data.offset) || 0, 0);

  let sql = "SELECT * FROM custom_exercises";
  const params: (string | number)[] = [];

  if (q) {
    sql += " WHERE name LIKE ? OR instructions LIKE ?";
    const like = `%${q}%`;
    params.push(like, like);
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  const results = (rows.results ?? []).map((row) =>
    normalizeCustomExercise(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/exercises", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(customExerciseInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  const result = await c.env.DB.prepare(
    `INSERT INTO custom_exercises (name, instructions, muscles_json, equipment_json, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.name,
      validation.data.instructions ?? null,
      mapJsonField(validation.data.muscles),
      mapJsonField(validation.data.equipment),
      validation.data.notes ?? null,
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, id: result.meta.last_row_id, created_at: createdAt }, 201);
});

app.get("/exercises/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT * FROM custom_exercises WHERE id = ?"
  )
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Exercise not found" }, 404);
  }

  return c.json(normalizeCustomExercise(row.results[0] as JsonRecord));
});

app.put("/exercises/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(customExerciseInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE custom_exercises
     SET name = ?, instructions = ?, muscles_json = ?, equipment_json = ?, notes = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.name,
      validation.data.instructions ?? null,
      mapJsonField(validation.data.muscles),
      mapJsonField(validation.data.equipment),
      validation.data.notes ?? null,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Exercise not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/exercises/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare(
    "DELETE FROM custom_exercises WHERE id = ?"
  )
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Exercise not found" }, 404);
  }

  return c.json({ ok: true, deleted_at: nowIso() });
});

app.get("/workout-templates", async (c) => {
  const query = c.req.query();
  const validation = validateQuery(customWorkoutTemplatesQuerySchema, query);
  if (!validation.ok) {
    return validation.response;
  }

  const q = validation.data.q?.trim();
  const limit = Math.min(Number(validation.data.limit) || 100, 500);
  const offset = Math.max(Number(validation.data.offset) || 0, 0);

  let sql = "SELECT * FROM custom_workout_templates";
  const params: (string | number)[] = [];

  if (q) {
    sql += " WHERE name LIKE ? OR description LIKE ?";
    const like = `%${q}%`;
    params.push(like, like);
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  const results = (rows.results ?? []).map((row) =>
    normalizeCustomWorkoutTemplate(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/workout-templates", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(customWorkoutTemplateInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  const result = await c.env.DB.prepare(
    `INSERT INTO custom_workout_templates (name, description, exercises_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.name,
      validation.data.description ?? null,
      mapJsonField(validation.data.exercises),
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, id: result.meta.last_row_id, created_at: createdAt }, 201);
});

app.get("/workout-templates/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT * FROM custom_workout_templates WHERE id = ?"
  )
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  return c.json(normalizeCustomWorkoutTemplate(row.results[0] as JsonRecord));
});

app.put("/workout-templates/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(customWorkoutTemplateInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE custom_workout_templates
     SET name = ?, description = ?, exercises_json = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.name,
      validation.data.description ?? null,
      mapJsonField(validation.data.exercises),
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/workout-templates/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare(
    "DELETE FROM custom_workout_templates WHERE id = ?"
  )
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  return c.json({ ok: true, deleted_at: nowIso() });
});

app.get("/workout-schedules", async (c) => {
  const query = c.req.query();
  const validation = validateQuery(customWorkoutSchedulesQuerySchema, query);
  if (!validation.ok) {
    return validation.response;
  }

  const templateId = validation.data.template_id
    ? Number(validation.data.template_id)
    : null;
  const start = validation.data.start;
  const end = validation.data.end;

  let sql = "SELECT * FROM custom_workout_schedules WHERE 1 = 1";
  const params: (string | number)[] = [];

  if (templateId && Number.isInteger(templateId)) {
    sql += " AND template_id = ?";
    params.push(templateId);
  }

  if (start) {
    sql += " AND (end_date IS NULL OR end_date >= ?)";
    params.push(start);
  }

  if (end) {
    sql += " AND (start_date IS NULL OR start_date <= ?)";
    params.push(end);
  }

  sql += " ORDER BY start_date DESC, created_at DESC";

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  const results = (rows.results ?? []).map((row) =>
    normalizeCustomWorkoutSchedule(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/workout-schedules", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(customWorkoutScheduleInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  const result = await c.env.DB.prepare(
    `INSERT INTO custom_workout_schedules (
      template_id, timezone, rrule, days_of_week_json, start_date, end_date, exceptions_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.template_id,
      validation.data.timezone,
      validation.data.rrule ?? null,
      mapJsonField(validation.data.days_of_week),
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      mapJsonField(validation.data.exceptions),
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, id: result.meta.last_row_id, created_at: createdAt }, 201);
});

app.get("/workout-schedules/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT * FROM custom_workout_schedules WHERE id = ?"
  )
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Schedule not found" }, 404);
  }

  return c.json(normalizeCustomWorkoutSchedule(row.results[0] as JsonRecord));
});

app.put("/workout-schedules/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(customWorkoutScheduleInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE custom_workout_schedules
     SET template_id = ?, timezone = ?, rrule = ?, days_of_week_json = ?, start_date = ?, end_date = ?, exceptions_json = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.template_id,
      validation.data.timezone,
      validation.data.rrule ?? null,
      mapJsonField(validation.data.days_of_week),
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      mapJsonField(validation.data.exceptions),
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Schedule not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/workout-schedules/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare(
    "DELETE FROM custom_workout_schedules WHERE id = ?"
  )
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Schedule not found" }, 404);
  }

  return c.json({ ok: true, deleted_at: nowIso() });
});

app.get("/workout-sessions", async (c) => {
  const query = c.req.query();
  const validation = validateQuery(customWorkoutSessionsQuerySchema, query);
  if (!validation.ok) {
    return validation.response;
  }

  const end = validation.data.end ?? nowIso();
  const start =
    validation.data.start ??
    new Date(new Date(end).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const status = validation.data.status;
  const templateId = validation.data.template_id
    ? Number(validation.data.template_id)
    : null;

  let sql =
    "SELECT * FROM custom_workout_sessions WHERE COALESCE(started_at, created_at) BETWEEN ? AND ?";
  const params: (string | number)[] = [start, end];

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }

  if (templateId && Number.isInteger(templateId)) {
    sql += " AND template_id = ?";
    params.push(templateId);
  }

  sql += " ORDER BY COALESCE(started_at, created_at) DESC";

  const rows = await c.env.DB.prepare(sql).bind(...params).all();

  return c.json({
    start,
    end,
    count: rows.results?.length ?? 0,
    sessions: rows.results ?? [],
  });
});

app.post("/workout-sessions", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(customWorkoutSessionInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  const result = await c.env.DB.prepare(
    `INSERT INTO custom_workout_sessions (template_id, title, status, started_at, ended_at, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.template_id ?? null,
      validation.data.title ?? null,
      validation.data.status,
      validation.data.started_at ?? null,
      validation.data.ended_at ?? null,
      validation.data.notes ?? null,
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, id: result.meta.last_row_id, created_at: createdAt }, 201);
});

app.get("/workout-sessions/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT * FROM custom_workout_sessions WHERE id = ?"
  )
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json(row.results[0] as JsonRecord);
});

app.put("/workout-sessions/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(customWorkoutSessionInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE custom_workout_sessions
     SET template_id = ?, title = ?, status = ?, started_at = ?, ended_at = ?, notes = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.template_id ?? null,
      validation.data.title ?? null,
      validation.data.status,
      validation.data.started_at ?? null,
      validation.data.ended_at ?? null,
      validation.data.notes ?? null,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/workout-sessions/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare(
    "DELETE FROM custom_workout_sessions WHERE id = ?"
  )
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({ ok: true, deleted_at: nowIso() });
});

app.get("/workout-sessions/:id/sets", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const rows = await c.env.DB.prepare(
    "SELECT * FROM custom_workout_sets WHERE session_id = ? ORDER BY set_number ASC, id ASC"
  )
    .bind(id)
    .all();

  const results = (rows.results ?? []).map((row) =>
    normalizeCustomWorkoutSet(row as JsonRecord)
  );

  return c.json({ count: results.length, sets: results });
});

app.post("/workout-sessions/:id/sets", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(workoutSetInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  const result = await c.env.DB.prepare(
    `INSERT INTO custom_workout_sets (
      session_id, exercise_id, set_number, reps, weight, weight_unit, rpe, done, notes, performed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      validation.data.exercise_id,
      validation.data.set_number,
      validation.data.reps ?? null,
      validation.data.weight ?? null,
      validation.data.weight_unit ?? null,
      validation.data.rpe ?? null,
      typeof validation.data.done === "boolean" ? (validation.data.done ? 1 : 0) : null,
      validation.data.notes ?? null,
      validation.data.performed_at ?? null,
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, id: result.meta.last_row_id, created_at: createdAt }, 201);
});

app.patch("/workout-sessions/:id/sets/:set_id", async (c) => {
  const sessionId = parseId(c.req.param("id"));
  const setId = parseId(c.req.param("set_id"));
  if (!sessionId || !setId) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(workoutSetPatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "exercise_id")) {
    updates.push("exercise_id = ?");
    params.push(validation.data.exercise_id ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "set_number")) {
    updates.push("set_number = ?");
    params.push(validation.data.set_number ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "reps")) {
    updates.push("reps = ?");
    params.push(validation.data.reps ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "weight")) {
    updates.push("weight = ?");
    params.push(validation.data.weight ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "weight_unit")) {
    updates.push("weight_unit = ?");
    params.push(validation.data.weight_unit ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "rpe")) {
    updates.push("rpe = ?");
    params.push(validation.data.rpe ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "done")) {
    updates.push("done = ?");
    params.push(
      typeof validation.data.done === "boolean"
        ? validation.data.done
          ? 1
          : 0
        : null
    );
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "notes")) {
    updates.push("notes = ?");
    params.push(validation.data.notes ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "performed_at")) {
    updates.push("performed_at = ?");
    params.push(validation.data.performed_at ?? null);
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE custom_workout_sets SET ${updates.join(", ")}
               WHERE id = ? AND session_id = ?`;
  params.push(setId, sessionId);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Set not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/workout-sessions/:id/sets/:set_id", async (c) => {
  const sessionId = parseId(c.req.param("id"));
  const setId = parseId(c.req.param("set_id"));
  if (!sessionId || !setId) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare(
    "DELETE FROM custom_workout_sets WHERE id = ? AND session_id = ?"
  )
    .bind(setId, sessionId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Set not found" }, 404);
  }

  return c.json({ ok: true, deleted_at: nowIso() });
});

export default app;
