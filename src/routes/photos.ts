import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizePhoto } from "../utils/normalizers";
import { fileExtensionForContentType } from "../utils/content-type";
import { photoSchema } from "../schemas/content";
import { photosResponseSchema } from "../schemas/responses";
import { listQuerySchema } from "../schemas/common";
import {
  openApiRegistry,
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
  presignResponseSchema,
  presignHeadersSchema,
  uploadTokenHeadersSchema,
  errorSchema,
} from "../schemas/openapi";
import {
  parseListQuery,
  createFilterBuilder,
  addSearchFilter,
  addTagsFilter,
  addDateRangeFilter,
  addPublishedFilter,
  buildWhereClause,
  parseSort,
  patchAssignments,
  publishedFlag,
} from "../utils/query";
import { declaresMoreThan, signUploadToken, UPLOAD_LIMITS, verifyUploadToken } from "../services/upload-token";

const app = new Hono<{ Bindings: Env }>();

/* ── Schemas ────────────────────────────────────────────────────────── */

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
  responses: okResponses(photosResponseSchema),
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

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos/presign",
  summary: "Create a presigned photo upload token",
  description: "The token is valid for 5 minutes. Upload the file with PUT /v1/photos/upload-presigned.",
  security: authSecurity,
  request: { headers: presignHeadersSchema },
  responses: {
    ...okResponses(presignResponseSchema),
    415: openApiResponse(errorSchema, "Unsupported content type"),
  },
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/photos/upload-presigned",
  summary: "Upload a photo with a presigned token",
  description: "Authenticated by the X-Upload-Token header instead of the bearer token.",
  request: {
    headers: uploadTokenHeadersSchema,
    body: {
      description: "Image file",
      content: {
        "image/*": { schema: imageUploadSchema },
      },
    },
  },
  responses: {
    201: openApiResponse(photoUploadResponseSchema, "Created"),
    400: openApiResponse(errorSchema, "Missing body"),
    401: openApiResponse(errorSchema, "Missing upload token"),
    403: openApiResponse(errorSchema, "Invalid or expired upload token"),
    413: openApiResponse(errorSchema, "File too large"),
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
  addPublishedFilter(filters, query);

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
  const id = idParam(c);
  if (!id) return badId(c);

  const query = c.req.query();
  const filters = createFilterBuilder();
  filters.clauses.push("id = ?");
  filters.params.push(id);
  addPublishedFilter(filters, query);

  const row = await c.env.DB.prepare(`SELECT * FROM photos${buildWhereClause(filters)}`)
    .bind(...filters.params)
    .all();

  if (!row.results || row.results.length === 0) {
    return notFound(c, "Photo");
  }

  return c.json(normalizePhoto(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const validation = await readBody(c, photoSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO photos (title, description, url, thumb_url, width, height, shot_at, camera, lens, settings, location, tags_json, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      validation.data.published === false ? 0 : 1,
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

// ── Presigned upload (must be before /:id routes) ────────────────────
app.post("/presign", async (c) => {
  const contentType = c.req.header("x-content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "Unsupported content type" }, 415);
  }

  const ext = fileExtensionForContentType(contentType);
  const key = `photos/${crypto.randomUUID()}.${ext}`;

  const uploadToken = await signUploadToken(key, contentType, c.env.API_TOKEN);
  const apiBase = c.env.API_BASE_URL?.replace(/\/$/, "") || "https://api.anuragd.me";

  return c.json({
    ok: true,
    key,
    uploadToken,
    uploadUrl: `${apiBase}/v1/photos/upload-presigned`,
    expiresIn: 300,
  });
});

app.put("/upload-presigned", async (c) => {
  const token = c.req.header("x-upload-token");
  if (!token) {
    return c.json({ error: "Missing upload token" }, 401);
  }

  const claim = await verifyUploadToken(token, c.env.API_TOKEN, "photos/");
  if (!claim) {
    return c.json({ error: "Invalid or expired upload token" }, 403);
  }

  if (declaresMoreThan(c.req.header("content-length"), UPLOAD_LIMITS.photosPresigned)) {
    return c.json({ error: "File too large" }, 413);
  }

  if (!c.req.raw.body) {
    return c.json({ error: "Missing body" }, 400);
  }

  await c.env.R2_BUCKET.put(claim.key, c.req.raw.body, {
    httpMetadata: { contentType: claim.contentType },
  });

  const baseUrl = c.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
  const url = baseUrl ? `${baseUrl}/${claim.key}` : claim.key;

  return c.json({ ok: true, key: claim.key, url, content_type: claim.contentType }, 201);
});

app.put("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, photoSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE photos
     SET title = ?, description = ?, url = ?, thumb_url = ?, width = ?, height = ?, shot_at = ?, camera = ?, lens = ?, settings = ?, location = ?, tags_json = ?, published = ?, updated_at = ?
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
      validation.data.published === false ? 0 : 1,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Photo");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, photoPatchSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const { sets: updates, params } = patchAssignments(validation.data, {
    title: true,
    description: true,
    url: true,
    thumb_url: true,
    width: true,
    height: true,
    shot_at: true,
    camera: true,
    lens: true,
    settings: true,
    location: true,
    tags: { column: "tags_json", to: mapJsonField },
    published: { to: publishedFlag },
  });

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE photos SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return notFound(c, "Photo");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const result = await c.env.DB.prepare("DELETE FROM photos WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Photo");
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

app.post("/upload", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "Unsupported content type" }, 415);
  }

  if (declaresMoreThan(c.req.header("content-length"), UPLOAD_LIMITS.photosDirect)) {
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
