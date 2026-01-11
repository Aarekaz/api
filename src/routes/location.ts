import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import { locationSchema, locationQuerySchema } from "../schemas/common";
import {
  openApiRegistry,
  genericArraySchema,
  okCreatedSchema,
  openApiJsonRequestBody,
  createdResponses,
  openApiResponseWithExample,
  authSecurity,
  errorResponses,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/location",
  summary: "List location history",
  security: authSecurity,
  request: {
    query: locationQuerySchema,
  },
  responses: {
    200: openApiResponseWithExample(genericArraySchema, "OK", [
      {
        id: 1,
        latitude: 40.7128,
        longitude: -74.006,
        altitude: 10.5,
        accuracy: 5.0,
        recorded_at: "2026-01-11T10:30:00.000Z",
        label: "work",
        source: "ios_shortcuts",
        created_at: "2026-01-11T10:30:15.000Z",
      },
    ]),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/location",
  summary: "Record location",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(locationSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/location/latest",
  summary: "Get latest location",
  security: authSecurity,
  responses: {
    200: openApiResponseWithExample(
      genericArraySchema,
      "OK",
      {
        id: 1,
        latitude: 40.7128,
        longitude: -74.006,
        recorded_at: "2026-01-11T10:30:00.000Z",
        label: "work",
      }
    ),
    ...errorResponses,
  },
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const validation = locationQuerySchema.safeParse(query);

  let start: string;
  let end: string;

  if (validation.success) {
    end = validation.data.end ?? nowIso();
    start =
      validation.data.start ??
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  } else {
    end = nowIso();
    start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const label = query.label;
  const limit = Math.min(Number(query.limit) || 1000, 10000);

  let sql = `SELECT * FROM location_history WHERE recorded_at BETWEEN ? AND ?`;
  const params: (string | number)[] = [start, end];

  if (label) {
    sql += ` AND label = ?`;
    params.push(label);
  }

  sql += ` ORDER BY recorded_at DESC LIMIT ?`;
  params.push(limit);

  const rows = await c.env.DB.prepare(sql).bind(...params).all();

  return c.json({
    start,
    end,
    label: label ?? null,
    count: rows.results?.length ?? 0,
    locations: rows.results ?? [],
  });
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(locationSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const now = nowIso();
  const result = await c.env.DB.prepare(
    `INSERT INTO location_history (
      latitude, longitude, altitude, accuracy, speed, heading, recorded_at,
      address, city, state, country, postal_code, label, notes, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.latitude,
      validation.data.longitude,
      validation.data.altitude ?? null,
      validation.data.accuracy ?? null,
      validation.data.speed ?? null,
      validation.data.heading ?? null,
      validation.data.recorded_at,
      validation.data.address ?? null,
      validation.data.city ?? null,
      validation.data.state ?? null,
      validation.data.country ?? null,
      validation.data.postal_code ?? null,
      validation.data.label ?? null,
      validation.data.notes ?? null,
      validation.data.source ?? null,
      now
    )
    .run();

  return c.json(
    {
      ok: true,
      id: result.meta.last_row_id,
      recorded_at: validation.data.recorded_at,
      created_at: now,
    },
    201
  );
});

app.get("/latest", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT * FROM location_history ORDER BY recorded_at DESC LIMIT 1"
  ).all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "No location data found" }, 404);
  }

  return c.json(row.results[0] as JsonRecord);
});

app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM location_history WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ ok: true, deleted: id });
});

export default app;
