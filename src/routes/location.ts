import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody, validateQuery } from "../utils/validation";
import { locationSchema, locationQuerySchema } from "../schemas/common";
import {
  openApiRegistry,
  genericArraySchema,
  genericObjectSchema,
  okCreatedSchema,
  okUpdatedSchema,
  okDeletedSchema,
  openApiJsonRequestBody,
  createdResponses,
  openApiResponseWithExample,
  okResponses,
  authSecurity,
  errorResponses,
} from "../schemas/openapi";
import { parseId } from "../utils/query";

const app = new Hono<{ Bindings: Env }>();

const locationPatchSchema = locationSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

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
  method: "get",
  path: "/v1/location/{id}",
  summary: "Get location",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
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
  method: "put",
  path: "/v1/location/{id}",
  summary: "Update location",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(locationSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/location/{id}",
  summary: "Patch location",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(locationPatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/location/{id}",
  summary: "Delete location",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
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
  const validation = validateQuery(locationQuerySchema, query);

  let start: string;
  let end: string;
  let label: string | null;
  let limit: number;
  let offset: number;

  if (validation.ok) {
    end = validation.data.end ?? nowIso();
    start =
      validation.data.start ??
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    label = validation.data.label ?? null;
    limit = Math.min(Number(validation.data.limit) || 1000, 10000);
    offset = Math.max(Number(validation.data.offset) || 0, 0);
  } else {
    end = nowIso();
    start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    label = null;
    limit = 1000;
    offset = 0;
  }

  let sql = `SELECT * FROM location_history WHERE recorded_at BETWEEN ? AND ?`;
  const params: (string | number)[] = [start, end];

  if (label) {
    sql += ` AND label = ?`;
    params.push(label);
  }

  sql += ` ORDER BY recorded_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(sql).bind(...params).all();

  return c.json({
    start,
    end,
    label,
    limit,
    offset,
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
      address, city, state, country, postal_code, label, notes, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      now,
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

app.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM location_history WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Location not found" }, 404);
  }

  return c.json(row.results[0] as JsonRecord);
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

  const validation = validateBody(locationSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE location_history
     SET latitude = ?, longitude = ?, altitude = ?, accuracy = ?, speed = ?, heading = ?, recorded_at = ?,
         address = ?, city = ?, state = ?, country = ?, postal_code = ?, label = ?, notes = ?, source = ?, updated_at = ?
     WHERE id = ?`
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
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Location not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(locationPatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "latitude")) {
    updates.push("latitude = ?");
    params.push(validation.data.latitude ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "longitude")) {
    updates.push("longitude = ?");
    params.push(validation.data.longitude ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "altitude")) {
    updates.push("altitude = ?");
    params.push(validation.data.altitude ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "accuracy")) {
    updates.push("accuracy = ?");
    params.push(validation.data.accuracy ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "speed")) {
    updates.push("speed = ?");
    params.push(validation.data.speed ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "heading")) {
    updates.push("heading = ?");
    params.push(validation.data.heading ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "recorded_at")) {
    updates.push("recorded_at = ?");
    params.push(validation.data.recorded_at ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "address")) {
    updates.push("address = ?");
    params.push(validation.data.address ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "city")) {
    updates.push("city = ?");
    params.push(validation.data.city ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "state")) {
    updates.push("state = ?");
    params.push(validation.data.state ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "country")) {
    updates.push("country = ?");
    params.push(validation.data.country ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "postal_code")) {
    updates.push("postal_code = ?");
    params.push(validation.data.postal_code ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "label")) {
    updates.push("label = ?");
    params.push(validation.data.label ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "notes")) {
    updates.push("notes = ?");
    params.push(validation.data.notes ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "source")) {
    updates.push("source = ?");
    params.push(validation.data.source ?? null);
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE location_history SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Location not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM location_history WHERE id = ?")
    .bind(id)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ error: "Location not found" }, 404);
  }
  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
