import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizePost } from "../utils/normalizers";
import { postSchema } from "../schemas/content";
import { postsResponseSchema } from "../schemas/responses";
import { listQuerySchema } from "../schemas/common";
import {
  openApiRegistry,
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
  patchAssignments,
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
  responses: okResponses(postsResponseSchema),
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
  const id = idParam(c);
  if (!id) return badId(c);

  const row = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return notFound(c, "Post");
  }

  return c.json(normalizePost(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const validation = await readBody(c, postSchema);
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
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, postSchema);
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
    return notFound(c, "Post");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, postPatchSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const { sets: updates, params } = patchAssignments(validation.data, {
    slug: true,
    title: true,
    summary: true,
    content: true,
    tags: { column: "tags_json", to: mapJsonField },
    published_at: true,
    pinned: { to: (value) => value ? 1 : 0 },
  });

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE posts SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return notFound(c, "Post");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const result = await c.env.DB.prepare("DELETE FROM posts WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Post");
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
