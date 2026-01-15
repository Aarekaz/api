import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeShelfItem } from "../utils/normalizers";
import { shelfItemSchema } from "../schemas/content";
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
  addTagsFilter,
  addDateRangeFilter,
  buildWhereClause,
  parseSort,
  parseId,
} from "../utils/query";

const app = new Hono<{ Bindings: Env }>();

const shelfPatchSchema = shelfItemSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

const shelfQuerySchema = listQuerySchema.extend({
  type: z.enum(["book", "movie"]).optional(),
});

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/shelf",
  summary: "List shelf items",
  security: authSecurity,
  request: { query: shelfQuerySchema },
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/shelf/{id}",
  summary: "Get shelf item",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/shelf",
  summary: "Create shelf item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfItemSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/shelf/{id}",
  summary: "Update shelf item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfItemSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/shelf/{id}",
  summary: "Patch shelf item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfPatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/shelf/{id}",
  summary: "Delete shelf item",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, tags, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["title", "author", "source", "quote", "note"]);
  addTagsFilter(filters, tags);
  addDateRangeFilter(filters, "date_added", start, end);

  if (query.type) {
    filters.clauses.push("type = ?");
    filters.params.push(query.type);
  }

  const orderBy = parseSort(
    sort,
    { date_added: "date_added", title: "title", author: "author" },
    "date_added DESC"
  );

  const sql = `SELECT * FROM shelf_items${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...filters.params, limit, offset)
    .all();
  const results = (rows.results ?? []).map((row) =>
    normalizeShelfItem(row as JsonRecord)
  );
  return c.json(results);
});

app.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM shelf_items WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Shelf item not found" }, 404);
  }

  return c.json(normalizeShelfItem(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(shelfItemSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  const dateAdded = validation.data.date_added ?? createdAt;
  await c.env.DB.prepare(
    `INSERT INTO shelf_items (type, title, quote, author, source, url, note, image_url, drawer, tags_json, date_added, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.type,
      validation.data.title ?? null,
      validation.data.quote ?? null,
      validation.data.author ?? null,
      validation.data.source ?? null,
      validation.data.url ?? null,
      validation.data.note ?? null,
      validation.data.image_url ?? null,
      validation.data.drawer ?? null,
      mapJsonField(validation.data.tags),
      dateAdded,
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

  const validation = validateBody(shelfItemSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE shelf_items
     SET type = ?, title = ?, quote = ?, author = ?, source = ?, url = ?, note = ?, image_url = ?, drawer = ?, tags_json = ?, date_added = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.type,
      validation.data.title ?? null,
      validation.data.quote ?? null,
      validation.data.author ?? null,
      validation.data.source ?? null,
      validation.data.url ?? null,
      validation.data.note ?? null,
      validation.data.image_url ?? null,
      validation.data.drawer ?? null,
      mapJsonField(validation.data.tags),
      validation.data.date_added ?? null,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Shelf item not found" }, 404);
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

  const validation = validateBody(shelfPatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "type")) {
    updates.push("type = ?");
    params.push(validation.data.type ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "title")) {
    updates.push("title = ?");
    params.push(validation.data.title ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "quote")) {
    updates.push("quote = ?");
    params.push(validation.data.quote ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "author")) {
    updates.push("author = ?");
    params.push(validation.data.author ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "source")) {
    updates.push("source = ?");
    params.push(validation.data.source ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "url")) {
    updates.push("url = ?");
    params.push(validation.data.url ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "note")) {
    updates.push("note = ?");
    params.push(validation.data.note ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "image_url")) {
    updates.push("image_url = ?");
    params.push(validation.data.image_url ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "drawer")) {
    updates.push("drawer = ?");
    params.push(validation.data.drawer ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "tags")) {
    updates.push("tags_json = ?");
    params.push(mapJsonField(validation.data.tags));
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "date_added")) {
    updates.push("date_added = ?");
    params.push(validation.data.date_added ?? null);
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE shelf_items SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Shelf item not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM shelf_items WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Shelf item not found" }, 404);
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
