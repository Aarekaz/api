import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizePost } from "../utils/normalizers";
import { postSchema } from "../schemas/content";
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
  openApiResponseWithExample,
  authSecurity,
  errorResponses,
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

const postPatchSchema = postSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/posts",
  summary: "List posts",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: {
    200: openApiResponseWithExample(genericArraySchema, "OK", [
      {
        id: 1,
        slug: "hello-world",
        title: "Hello World",
        summary: "My first post",
        content: "Lorem ipsum...",
        tags: ["meta"],
        published_at: "2025-01-01T00:00:00.000Z",
        pinned: false,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    ]),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/posts/{id}",
  summary: "Get post",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/posts",
  summary: "Create post",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(postSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/posts/{id}",
  summary: "Update post",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(postSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/posts/{id}",
  summary: "Patch post",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(postPatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/posts/{id}",
  summary: "Delete post",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, tags, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["slug", "title", "summary", "content"]);
  addTagsFilter(filters, tags);
  addDateRangeFilter(filters, "published_at", start, end);

  const orderBy = parseSort(
    sort,
    {
      published_at: "published_at",
      updated_at: "updated_at",
      title: "title",
      slug: "slug",
    },
    "published_at DESC, updated_at DESC"
  );

  const sql = `SELECT * FROM posts${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...filters.params, limit, offset)
    .all();
  const results = (rows.results ?? []).map((row) =>
    normalizePost(row as JsonRecord)
  );
  return c.json(results);
});

app.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Post not found" }, 404);
  }

  return c.json(normalizePost(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(postSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO posts (slug, title, summary, content, tags_json, published_at, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.slug,
      validation.data.title,
      validation.data.summary ?? null,
      validation.data.content ?? null,
      mapJsonField(validation.data.tags),
      validation.data.published_at ?? null,
      validation.data.pinned ? 1 : 0,
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

  const validation = validateBody(postSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE posts
     SET slug = ?, title = ?, summary = ?, content = ?, tags_json = ?, published_at = ?, pinned = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.slug,
      validation.data.title,
      validation.data.summary ?? null,
      validation.data.content ?? null,
      mapJsonField(validation.data.tags),
      validation.data.published_at ?? null,
      validation.data.pinned ? 1 : 0,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Post not found" }, 404);
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

  const validation = validateBody(postPatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "slug")) {
    updates.push("slug = ?");
    params.push(validation.data.slug ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "title")) {
    updates.push("title = ?");
    params.push(validation.data.title ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "summary")) {
    updates.push("summary = ?");
    params.push(validation.data.summary ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "content")) {
    updates.push("content = ?");
    params.push(validation.data.content ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "tags")) {
    updates.push("tags_json = ?");
    params.push(mapJsonField(validation.data.tags));
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "published_at")) {
    updates.push("published_at = ?");
    params.push(validation.data.published_at ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "pinned")) {
    updates.push("pinned = ?");
    params.push(validation.data.pinned ? 1 : 0);
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE posts SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Post not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM posts WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Post not found" }, 404);
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
