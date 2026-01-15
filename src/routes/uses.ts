import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import { usesItemSchema } from "../schemas/content";
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

const usesPatchSchema = usesItemSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/uses",
  summary: "List uses items",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/uses/{id}",
  summary: "Get uses item",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/uses",
  summary: "Create uses item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(usesItemSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/uses/{id}",
  summary: "Update uses item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(usesItemSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/uses/{id}",
  summary: "Patch uses item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(usesPatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/uses/{id}",
  summary: "Delete uses item",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["category", "name", "note"]);
  addDateRangeFilter(filters, "created_at", start, end);

  const orderBy = parseSort(
    sort,
    { category: "category", name: "name", created_at: "created_at" },
    "category ASC, name ASC"
  );

  const sql = `SELECT * FROM uses_items${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
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

  const row = await c.env.DB.prepare("SELECT * FROM uses_items WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Uses item not found" }, 404);
  }

  return c.json(row.results[0]);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(usesItemSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO uses_items (category, name, url, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.category,
      validation.data.name,
      validation.data.url ?? null,
      validation.data.note ?? null,
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

  const validation = validateBody(usesItemSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE uses_items
     SET category = ?, name = ?, url = ?, note = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.category,
      validation.data.name,
      validation.data.url ?? null,
      validation.data.note ?? null,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Uses item not found" }, 404);
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

  const validation = validateBody(usesPatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "category")) {
    updates.push("category = ?");
    params.push(validation.data.category ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "name")) {
    updates.push("name = ?");
    params.push(validation.data.name ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "url")) {
    updates.push("url = ?");
    params.push(validation.data.url ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "note")) {
    updates.push("note = ?");
    params.push(validation.data.note ?? null);
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE uses_items SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Uses item not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM uses_items WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Uses item not found" }, 404);
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
