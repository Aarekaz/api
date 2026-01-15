import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeNote } from "../utils/normalizers";
import { noteSchema } from "../schemas/content";
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

const notePatchSchema = noteSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/notes",
  summary: "List notes",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/notes/{id}",
  summary: "Get note",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/notes",
  summary: "Create note",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(noteSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/notes/{id}",
  summary: "Update note",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(noteSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/notes/{id}",
  summary: "Patch note",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(notePatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/notes/{id}",
  summary: "Delete note",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, tags, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["title", "body"]);
  addTagsFilter(filters, tags);
  addDateRangeFilter(filters, "created_at", start, end);

  const orderBy = parseSort(
    sort,
    { created_at: "created_at", title: "title" },
    "created_at DESC"
  );

  const sql = `SELECT * FROM notes${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...filters.params, limit, offset)
    .all();
  const results = (rows.results ?? []).map((row) =>
    normalizeNote(row as JsonRecord)
  );
  return c.json(results);
});

app.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Note not found" }, 404);
  }

  return c.json(normalizeNote(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(noteSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO notes (title, body, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.title ?? null,
      validation.data.body ?? null,
      mapJsonField(validation.data.tags),
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

  const validation = validateBody(noteSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE notes
     SET title = ?, body = ?, tags_json = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.title ?? null,
      validation.data.body ?? null,
      mapJsonField(validation.data.tags),
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Note not found" }, 404);
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

  const validation = validateBody(notePatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "title")) {
    updates.push("title = ?");
    params.push(validation.data.title ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "body")) {
    updates.push("body = ?");
    params.push(validation.data.body ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "tags")) {
    updates.push("tags_json = ?");
    params.push(mapJsonField(validation.data.tags));
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE notes SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Note not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM notes WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Note not found" }, 404);
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
