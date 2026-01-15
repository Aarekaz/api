import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import { educationSchema } from "../schemas/profile";
import { listQuerySchema } from "../schemas/common";
import {
  openApiRegistry,
  genericArraySchema,
  genericObjectSchema,
  okCreatedSchema,
  okUpdatedSchema,
  okDeletedSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";
import {
  parseListQuery,
  createFilterBuilder,
  addSearchFilter,
  addDateRangeFilter,
  buildWhereClause,
  parseSort,
  parseId,
} from "../utils/query";

const app = new Hono<{ Bindings: Env }>();

const educationPatchSchema = educationSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/education",
  summary: "List education",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/education/{id}",
  summary: "Get education",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/education",
  summary: "Create education",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(educationSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/education/{id}",
  summary: "Update education",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(educationSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/education/{id}",
  summary: "Patch education",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(educationPatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/education/{id}",
  summary: "Delete education",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["institution", "degree", "field", "description"]);
  addDateRangeFilter(filters, "start_date", start, end);

  const orderBy = parseSort(
    sort,
    { start_date: "start_date", institution: "institution" },
    "start_date DESC"
  );

  const sql = `SELECT * FROM education${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...filters.params, limit, offset)
    .all();
  return c.json(rows.results ?? []);
});

app.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM education WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Education not found" }, 404);
  }

  return c.json(row.results[0]);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(educationSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO education (institution, degree, field, start_date, end_date, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.institution,
      validation.data.degree ?? null,
      validation.data.field ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      validation.data.description ?? null,
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
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

  const validation = validateBody(educationSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE education
     SET institution = ?, degree = ?, field = ?, start_date = ?, end_date = ?, description = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.institution,
      validation.data.degree ?? null,
      validation.data.field ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      validation.data.description ?? null,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Education not found" }, 404);
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

  const validation = validateBody(educationPatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "institution")) {
    updates.push("institution = ?");
    params.push(validation.data.institution ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "degree")) {
    updates.push("degree = ?");
    params.push(validation.data.degree ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "field")) {
    updates.push("field = ?");
    params.push(validation.data.field ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "start_date")) {
    updates.push("start_date = ?");
    params.push(validation.data.start_date ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "end_date")) {
    updates.push("end_date = ?");
    params.push(validation.data.end_date ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "description")) {
    updates.push("description = ?");
    params.push(validation.data.description ?? null);
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE education SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Education not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM education WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Education not found" }, 404);
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
