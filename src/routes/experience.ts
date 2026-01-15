import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import { experienceSchema } from "../schemas/profile";
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

const experiencePatchSchema = experienceSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/experience",
  summary: "List experience",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/experience/{id}",
  summary: "Get experience",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/experience",
  summary: "Create experience",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(experienceSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/experience/{id}",
  summary: "Update experience",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(experienceSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/experience/{id}",
  summary: "Patch experience",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(experiencePatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/experience/{id}",
  summary: "Delete experience",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["company", "role", "location", "description"]);
  addDateRangeFilter(filters, "start_date", start, end);

  const orderBy = parseSort(
    sort,
    { start_date: "start_date", company: "company", role: "role" },
    "start_date DESC"
  );

  const sql = `SELECT * FROM experience${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
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

  const row = await c.env.DB.prepare("SELECT * FROM experience WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Experience not found" }, 404);
  }

  return c.json(row.results[0]);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(experienceSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO experience (company, role, location, start_date, end_date, employment_type, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.company,
      validation.data.role,
      validation.data.location ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      validation.data.employment_type ?? null,
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

  const validation = validateBody(experienceSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE experience
     SET company = ?, role = ?, location = ?, start_date = ?, end_date = ?, employment_type = ?, description = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.company,
      validation.data.role,
      validation.data.location ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      validation.data.employment_type ?? null,
      validation.data.description ?? null,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Experience not found" }, 404);
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

  const validation = validateBody(experiencePatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "company")) {
    updates.push("company = ?");
    params.push(validation.data.company ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "role")) {
    updates.push("role = ?");
    params.push(validation.data.role ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "location")) {
    updates.push("location = ?");
    params.push(validation.data.location ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "start_date")) {
    updates.push("start_date = ?");
    params.push(validation.data.start_date ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "end_date")) {
    updates.push("end_date = ?");
    params.push(validation.data.end_date ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "employment_type")) {
    updates.push("employment_type = ?");
    params.push(validation.data.employment_type ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "description")) {
    updates.push("description = ?");
    params.push(validation.data.description ?? null);
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE experience SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Experience not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM experience WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Experience not found" }, 404);
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
