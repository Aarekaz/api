import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizePhoto } from "../utils/normalizers";
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
import { directUpload, presign, presignedPut } from "../lib/uploads";
import { UPLOAD_KINDS } from "../services/upload-token";

const app = new Hono<{ Bindings: Env }>();

/* ── Schemas ────────────────────────────────────────────────────────── */

const photoPatchSchema = photoSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
// Raster images only (UPLOAD_KINDS.photo): never SVG, which is script on the media domain.
const photoBody = {
  description: "JPEG, PNG, HEIC/HEIF, WebP, GIF or AVIF image",
  content: Object.fromEntries(UPLOAD_KINDS.photo.types.map((type) => [type, { schema: imageUploadSchema }])),
};
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
    body: photoBody,
  },
  responses: {
    201: openApiResponse(photoUploadResponseSchema, "Created"),
    ...errorResponses,
    411: openApiResponse(errorSchema, "Length required (no Content-Length)"),
    413: openApiResponse(errorSchema, "File too large"),
    415: openApiResponse(errorSchema, "Unsupported content type"),
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
    body: photoBody,
  },
  responses: {
    201: openApiResponse(photoUploadResponseSchema, "Created"),
    400: openApiResponse(errorSchema, "Missing body"),
    401: openApiResponse(errorSchema, "Missing upload token"),
    403: openApiResponse(errorSchema, "Invalid, expired or already used upload token (each token stores one file)"),
    411: openApiResponse(errorSchema, "Length required (no Content-Length)"),
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
app.post("/presign", presign("photo"));
app.put("/upload-presigned", presignedPut("photo"));

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

app.post("/upload", directUpload("photo"));

export default app;
