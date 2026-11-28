import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizePhoto } from "../utils/normalizers";
import { describedFields, photoSchema } from "../schemas/content";
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
  apiTags,
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
import { applyPhotoVisibility, isPhotoFileName, photoFileName } from "../services/photo-privacy";
import { photoResponse } from "../lib/private-photos";

const app = new Hono<{ Bindings: Env }>();

/* ── Schemas ────────────────────────────────────────────────────────── */

const photoPatchSchema = photoSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
const TAG = "Photography";
apiTags.push({
  name: TAG,
  description: `Real photographs meant for anuragd.me/photography, with their camera details. Nothing else goes here: \
screenshots, receipts, memes and things shared from other apps go to the Inbox as notes (POST /v1/capture, with the image \
uploaded through POST /v1/documents/photos), never to Photography. A note's photos are private.

**Public or private.** A photo with \`published: true\` is on anuragd.me. A hidden one is private: its file is kept in the \
private bucket and read only through GET /v1/photos/file/{name}, signed in. Publishing copies the file to the \
public media bucket and points \`url\` there; hiding it again removes that copy. \`published\` defaults to **true** when it \
is left out, on POST and on PUT, so always send \`published: false\`. Agents create photos hidden. Only the owner puts a \
photo on the site, after a two-step confirm: show the photo and its details, get a yes, then confirm once more.

**Order of calls.** 1. Upload the file. 2. POST /v1/photos with \`url\` set to the upload's \`url\`, \`published: false\` \
and the details you know. The reply has no id: find the photo with GET /v1/photos?include_unpublished=1&sort=-created_at. \
Before uploading, check it isn't already there: GET /v1/photos?include_unpublished=1&search=<title>, or the same \`shot_at\`.

**Uploads.** Raster images only: JPEG, PNG, HEIC/HEIF, WebP, GIF or AVIF (no SVG). Either POST the bytes to \
/v1/photos/upload with the image's Content-Type and a Content-Length (up to 10 MB), or, for bigger files, POST \
/v1/photos/presign with an X-Content-Type header and PUT the bytes to the \`uploadUrl\` it returns with the X-Upload-Token \
header (up to 50 MB; the token lasts 5 minutes and stores one file). Either way the file lands in the private bucket and the \
reply's \`url\` is the private address. Use this upload rather than an outside link: only uploaded files are kept private \
while hidden.

**Reading.** GET /v1/photos and GET /v1/photos/{id} return published photos only. Add \`include_unpublished=1\` to see \
hidden ones too. The website's token may only call GET /v1/photos, without that flag, so it sees published photos only.

**Avoid.** PUT replaces every field, and a PUT without \`published\` publishes the photo: use PATCH with only the fields \
you change, and leave \`published\` to the owner. DELETE removes the row for good.`,
});
// The request body with its field notes (photoSchema is also the base of PhotoResponse, so the notes live here).
const photoBodyDoc = describedFields(photoSchema, {
  title: "Shown under the photo on the site. Short",
  description: "A caption. Optional",
  url: "The `url` the upload returned (POST /v1/photos/upload or the presigned PUT)",
  thumb_url: "A smaller copy, uploaded the same way. Leave it out if there isn't one",
  width: "Pixels",
  height: "Pixels",
  shot_at: "When it was taken (ISO 8601), from the photo's EXIF when it has one",
  camera: "Camera body, as EXIF names it: \"FUJIFILM X100V\"",
  lens: "Lens, as EXIF names it",
  settings: "Exposure in one line, as the app writes it: \"f/1.8 · 1/250 · ISO 100\"",
  location: "A place name, like \"Kathmandu\". Not coordinates",
  tags: "Short words for grouping",
  published: "true puts the photo on anuragd.me. Defaults to true when left out: agents always send false. Only the owner publishes",
});
// Raster images only (UPLOAD_KINDS.photo): never SVG, which is script on the media domain.
const photoBody = {
  description: "JPEG, PNG, HEIC/HEIF, WebP, GIF or AVIF image",
  content: Object.fromEntries(UPLOAD_KINDS.photo.types.map((type) => [type, { schema: imageUploadSchema }])),
};
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/photos",
  tags: [TAG],
  summary: "List photos",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(photosResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/photos/{id}",
  tags: [TAG],
  summary: "Get photo",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos",
  tags: [TAG],
  summary: "Create photo",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(photoBodyDoc) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/photos/{id}",
  tags: [TAG],
  summary: "Update photo",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(photoBodyDoc) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/photos/{id}",
  tags: [TAG],
  summary: "Patch photo",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(photoBodyDoc.partial()) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/photos/{id}",
  tags: [TAG],
  summary: "Delete photo",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos/upload",
  tags: [TAG],
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
  tags: [TAG],
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
  tags: [TAG],
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

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/photos/file/{name}",
  tags: [TAG],
  summary: "A photo's file",
  description: "Hidden (Only you) photos are kept privately and served only here, to the signed-in apps. Published photos are also on the public media domain.",
  security: authSecurity,
  responses: { 200: { description: "The image" }, 404: openApiResponse(errorSchema, "No such photo") },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos/privacy",
  tags: [TAG],
  summary: "Move photo files to match their visibility",
  description: "Hidden photos' files go to the private bucket (their public copy removed); published ones get a public copy. Lists what would move; ?apply=1 moves it.",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
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
  const inserted = await c.env.DB.prepare(
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

  const id = Number(inserted.meta.last_row_id);
  if (id) await applyPhotoVisibility(c.env, id);
  return c.json({ ok: true, created_at: createdAt }, 201);
});

// ── Presigned upload (must be before /:id routes) ────────────────────
app.post("/presign", presign("photo"));

// ── Private files (services/photo-privacy.ts) ────────────────────────
/** GET /v1/photos/file/:name: a photo's file, for the signed-in apps (hidden ones live only here). */
app.get("/file/:name", async (c) => {
  const name = c.req.param("name");
  if (!isPhotoFileName(name)) return c.json({ error: "No such photo" }, 404);
  const key = `photos/${name}`;
  const object = (await c.env.R2_PRIVATE?.get(key)) ?? (await c.env.R2_BUCKET.get(key));
  if (!object) return c.json({ error: "No such photo" }, 404);
  return photoResponse(object);
});

/**
 * POST /v1/photos/privacy (?apply=1): moves every photo's files to match its
 * visibility. Without apply, only lists what would move. For photos uploaded
 * before hidden ones were kept privately.
 */
app.post("/privacy", async (c) => {
  const apply = c.req.query("apply") === "1";
  const rows = await c.env.DB.prepare("SELECT id, title, url, published FROM photos ORDER BY id").all<{ id: number; title: string | null; url: string | null; published: number | null }>();
  const moves = [];
  const unmovable = [];
  for (const row of rows.results ?? []) {
    if (row.published === 0 && !photoFileName(c.env, row.url)) unmovable.push({ id: row.id, title: row.title, url: row.url });
    const move = await applyPhotoVisibility(c.env, row.id, !apply);
    if (move) moves.push(move);
  }
  return c.json({ ok: true, applied: apply, checked: rows.results?.length ?? 0, moves, unmovable });
});
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

  await applyPhotoVisibility(c.env, id);
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

  await applyPhotoVisibility(c.env, id);
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
