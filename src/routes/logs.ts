import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { addDays, dateOnly, nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody, validateQuery } from "../utils/validation";
import { normalizeLogDay } from "../utils/normalizers";
import { logDayInputSchema, logDaySchema, logsQuerySchema } from "../schemas/logs";
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

const logsListSchema = z.object({
  start: z.string(),
  end: z.string(),
  count: z.number(),
  logs: z.array(logDaySchema),
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
  path: "/v1/logs",
  summary: "List daily logs",
  security: authSecurity,
  request: { query: logsQuerySchema },
  responses: okResponses(logsListSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/logs",
  summary: "Create daily log",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(logDayInputSchema) },
  responses: createdResponses(okCreatedWithIdSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/logs/{id}",
  summary: "Get daily log",
  security: authSecurity,
  responses: okResponses(logDaySchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/logs/{id}",
  summary: "Update daily log",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(logDayInputSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/logs/{id}",
  summary: "Delete daily log",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const validation = validateQuery(logsQuerySchema, query);
  if (!validation.ok) {
    return validation.response;
  }

  const end = validation.data.end ?? dateOnly(new Date());
  const start =
    validation.data.start ?? dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));
  const limit = Math.min(Number(validation.data.limit) || 200, 1000);

  const rows = await c.env.DB.prepare(
    "SELECT * FROM daily_logs WHERE log_date BETWEEN ? AND ? ORDER BY log_date DESC LIMIT ?"
  )
    .bind(start, end, limit)
    .all();

  const logs = (rows.results ?? []).map((row) =>
    normalizeLogDay(row as JsonRecord)
  );

  return c.json({
    start,
    end,
    count: logs.length,
    logs,
  });
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(logDayInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM daily_logs WHERE log_date = ?"
  )
    .bind(validation.data.log_date)
    .all();

  if (existing.results && existing.results.length > 0) {
    return c.json({ error: "Log already exists for this date" }, 409);
  }

  const createdAt = nowIso();
  const result = await c.env.DB.prepare(
    `INSERT INTO daily_logs (log_date, title, summary, tags_json, entries_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.log_date,
      validation.data.title ?? null,
      validation.data.summary ?? null,
      mapJsonField(validation.data.tags),
      mapJsonField(validation.data.entries),
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, id: result.meta.last_row_id, created_at: createdAt }, 201);
});

app.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM daily_logs WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Log not found" }, 404);
  }

  return c.json(normalizeLogDay(row.results[0] as JsonRecord));
});

app.put("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(logDayInputSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const existing = await c.env.DB.prepare("SELECT log_date FROM daily_logs WHERE id = ?")
    .bind(id)
    .all();

  if (!existing.results || existing.results.length === 0) {
    return c.json({ error: "Log not found" }, 404);
  }

  const currentDate = (existing.results[0] as JsonRecord).log_date as string;
  if (validation.data.log_date !== currentDate) {
    const conflict = await c.env.DB.prepare(
      "SELECT id FROM daily_logs WHERE log_date = ?"
    )
      .bind(validation.data.log_date)
      .all();
    if (conflict.results && conflict.results.length > 0) {
      return c.json({ error: "Log already exists for this date" }, 409);
    }
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE daily_logs
     SET log_date = ?, title = ?, summary = ?, tags_json = ?, entries_json = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.log_date,
      validation.data.title ?? null,
      validation.data.summary ?? null,
      mapJsonField(validation.data.tags),
      mapJsonField(validation.data.entries),
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Log not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM daily_logs WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Log not found" }, 404);
  }

  return c.json({ ok: true, deleted_at: nowIso() });
});

export default app;
