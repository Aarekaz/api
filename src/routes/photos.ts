import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizePhoto } from "../utils/normalizers";
import { fileExtensionForContentType } from "../utils/response";
import { photoSchema } from "../schemas/content";
import { listQuerySchema } from "../schemas/common";
import {
  openApiRegistry,
  genericArraySchema,
  genericObjectSchema,
  okCreatedSchema,
  okUpdatedSchema,
  okDeletedSchema,
  photoUploadResponseSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  openApiResponse,
  authSecurity,
  errorResponses,
  imageUploadSchema,
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

const photoPatchSchema = photoSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/photos",
  summary: "List photos",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/photos/{id}",
  summary: "Get photo",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos",
  summary: "Create photo",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(photoSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/photos/{id}",
  summary: "Update photo",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(photoSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/photos/{id}",
  summary: "Patch photo",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(photoPatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/photos/{id}",
  summary: "Delete photo",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos/upload",
  summary: "Upload photo to R2",
  security: authSecurity,
  request: {
    body: {
      description: "Image file",
      content: {
        "image/*": { schema: imageUploadSchema },
      },
    },
  },
  responses: {
    201: openApiResponse(photoUploadResponseSchema, "Created"),
    ...errorResponses,
  },
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, tags, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, [
    "title",
    "description",
    "location",
    "camera",
    "lens",
    "settings",
  ]);
  addTagsFilter(filters, tags);
  addDateRangeFilter(filters, "COALESCE(shot_at, created_at)", start, end);

  const orderBy = parseSort(
    sort,
    { shot_at: "shot_at", created_at: "created_at", title: "title" },
    "shot_at DESC, created_at DESC"
  );

  const sql = `SELECT * FROM photos${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...filters.params, limit, offset)
    .all();
  const results = (rows.results ?? []).map((row) =>
    normalizePhoto(row as JsonRecord)
  );
  return c.json(results);
});

app.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM photos WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Photo not found" }, 404);
  }

  return c.json(normalizePhoto(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(photoSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO photos (title, description, url, thumb_url, width, height, shot_at, camera, lens, settings, location, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.title ?? null,
      validation.data.description ?? null,
      validation.data.url,
      validation.data.thumb_url ?? null,
      validation.data.width ?? null,
      validation.data.height ?? null,
      validation.data.shot_at ?? null,
      validation.data.camera ?? null,
      validation.data.lens ?? null,
      validation.data.settings ?? null,
      validation.data.location ?? null,
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

  const validation = validateBody(photoSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE photos
     SET title = ?, description = ?, url = ?, thumb_url = ?, width = ?, height = ?, shot_at = ?, camera = ?, lens = ?, settings = ?, location = ?, tags_json = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.title ?? null,
      validation.data.description ?? null,
      validation.data.url,
      validation.data.thumb_url ?? null,
      validation.data.width ?? null,
      validation.data.height ?? null,
      validation.data.shot_at ?? null,
      validation.data.camera ?? null,
      validation.data.lens ?? null,
      validation.data.settings ?? null,
      validation.data.location ?? null,
      mapJsonField(validation.data.tags),
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Photo not found" }, 404);
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

  const validation = validateBody(photoPatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "title")) {
    updates.push("title = ?");
    params.push(validation.data.title ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "description")) {
    updates.push("description = ?");
    params.push(validation.data.description ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "url")) {
    updates.push("url = ?");
    params.push(validation.data.url ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "thumb_url")) {
    updates.push("thumb_url = ?");
    params.push(validation.data.thumb_url ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "width")) {
    updates.push("width = ?");
    params.push(validation.data.width ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "height")) {
    updates.push("height = ?");
    params.push(validation.data.height ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "shot_at")) {
    updates.push("shot_at = ?");
    params.push(validation.data.shot_at ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "camera")) {
    updates.push("camera = ?");
    params.push(validation.data.camera ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "lens")) {
    updates.push("lens = ?");
    params.push(validation.data.lens ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "settings")) {
    updates.push("settings = ?");
    params.push(validation.data.settings ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "location")) {
    updates.push("location = ?");
    params.push(validation.data.location ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "tags")) {
    updates.push("tags_json = ?");
    params.push(mapJsonField(validation.data.tags));
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE photos SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Photo not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM photos WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Photo not found" }, 404);
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

app.post("/upload", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "Unsupported content type" }, 415);
  }

  const contentLength = c.req.header("content-length");
  if (contentLength && Number(contentLength) > 10 * 1024 * 1024) {
    return c.json({ error: "File too large" }, 413);
  }

  if (!c.req.raw.body) {
    return c.json({ error: "Missing body" }, 400);
  }

  const ext = fileExtensionForContentType(contentType);
  const key = `photos/${crypto.randomUUID()}.${ext}`;

  await c.env.R2_BUCKET.put(key, c.req.raw.body, {
    httpMetadata: { contentType },
  });

  const baseUrl = c.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
  const url = baseUrl ? `${baseUrl}/${key}` : key;

  return c.json(
    {
      ok: true,
      key,
      url,
      content_type: contentType,
    },
    201
  );
});

export default app;
