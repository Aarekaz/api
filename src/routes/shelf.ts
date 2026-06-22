import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeShelfItem } from "../utils/normalizers";
import { shelfItemBaseSchema, shelfItemSchema, statusMatchesShelfType } from "../schemas/content";
import { listQuerySchema } from "../schemas/common";
import { getTmdbMedia, normalizeTmdbMediaType, searchTmdbMedia, type TmdbCandidate } from "../services/tmdb";
import { getTag, mergeTags } from "../utils/tags";
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
  addPublishedFilter,
  buildWhereClause,
  parseSort,
  parseId,
} from "../utils/query";

const app = new Hono<{ Bindings: Env }>();

const shelfPatchSchema = shelfItemBaseSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

const shelfEnrichSchema = z.object({
  tmdb_id: z.number().int().positive().optional(),
  tmdb_media_type: z.enum(["movie", "tv"]).optional(),
  title: z.string().optional(),
  year: z.string().optional(),
});

const shelfQuerySchema = listQuerySchema.extend({
  type: z.enum(["book", "movie", "show"]).optional(),
});

type ShelfItemInput = z.infer<typeof shelfItemSchema>;

function shelfStateParams(data: ShelfItemInput) {
  return [
    data.status ?? null,
    data.rating ?? null,
    data.rating_scale ?? null,
    data.started_at ?? null,
    data.completed_at ?? null,
    data.last_watched_at ?? null,
    data.progress_current ?? null,
    data.progress_total ?? null,
    data.progress_unit ?? null,
    data.favorite_rank ?? null,
    data.showcase === true ? 1 : 0,
    mapJsonField(data.metadata),
  ];
}

function shelfControlParams(data: ShelfItemInput) {
  return [
    data.shelf_group ?? null,
    data.display_order ?? null,
    data.cover_override_url ?? null,
    data.spine_image_url ?? null,
    data.goodreads_id ?? null,
    data.isbn ?? null,
    data.apple_books_id ?? null,
  ];
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  );
}

function normalizeTmdbMetadata(candidate: TmdbCandidate): JsonRecord {
  return compactRecord({
    id: candidate.tmdb_id,
    media_type: candidate.tmdb_media_type,
    title: candidate.title,
    original_title: candidate.original_title,
    year: candidate.year,
    release_date: candidate.release_date,
    overview: candidate.overview,
    poster_path: candidate.poster_path,
    poster_url: candidate.poster_url,
    backdrop_path: candidate.backdrop_path,
    backdrop_url: candidate.backdrop_url,
  });
}

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

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/shelf/{id}/enrich",
  summary: "Enrich shelf item with TMDB poster metadata",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfEnrichSchema) },
  responses: okResponses(genericObjectSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, tags, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["title", "author", "source", "quote", "note"]);
  addTagsFilter(filters, tags);
  addDateRangeFilter(filters, "date_added", start, end);
  addPublishedFilter(filters, query);

  if (query.type) {
    filters.clauses.push("type = ?");
    filters.params.push(query.type);
  }

  const orderBy = parseSort(
    sort,
    {
      date_added: "date_added",
      title: "title",
      author: "author",
      completed_at: "completed_at",
      display_order: "display_order",
      shelf_group: "shelf_group",
    },
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

app.post("/:id/enrich", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  const validation = body === null ? shelfEnrichSchema.safeParse({}) : shelfEnrichSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: validation.error.issues[0]?.message ?? "Invalid body" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM shelf_items WHERE id = ?")
    .bind(id)
    .all();
  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Shelf item not found" }, 404);
  }

  const item = normalizeShelfItem(row.results[0] as JsonRecord);
  const tags = item.tags;
  const mediaType =
    validation.data.tmdb_media_type ??
    normalizeTmdbMediaType(getTag(tags, "tmdb_media_type")) ??
    normalizeTmdbMediaType(getTag(tags, "kind")) ??
    normalizeTmdbMediaType(String(item.type ?? "")) ??
    normalizeTmdbMediaType(String(item.drawer ?? ""));

  if (!mediaType) {
    return c.json({ error: "Shelf item is not a movie or show" }, 400);
  }

  let candidate: TmdbCandidate | null = null;
  try {
    if (validation.data.tmdb_id) {
      candidate = await getTmdbMedia(c.env, {
        type: mediaType,
        tmdbId: validation.data.tmdb_id,
      });
    } else {
      const title = validation.data.title ?? String(item.title ?? item.quote ?? "");
      const year = validation.data.year ?? getTag(tags, "year");
      candidate = (await searchTmdbMedia(c.env, { type: mediaType, query: title, year, limit: 1 }))[0] ?? null;
    }
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "TMDB enrichment failed" },
      502
    );
  }

  if (!candidate?.poster_url) {
    return c.json({ error: "No TMDB poster match found" }, 404);
  }

  const nextTags = mergeTags(tags, [
    `tmdb_id:${candidate.tmdb_id}`,
    `tmdb_media_type:${candidate.tmdb_media_type}`,
    "poster_source:tmdb",
    candidate.year ? `year:${candidate.year}` : "",
  ].filter(Boolean));
  const nextMetadata = {
    ...(isJsonRecord(item.metadata) ? item.metadata : {}),
    tmdb: normalizeTmdbMetadata(candidate),
  };
  const updatedAt = nowIso();

  await c.env.DB.prepare(
    `UPDATE shelf_items SET image_url = ?, tags_json = ?, metadata_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(candidate.poster_url, mapJsonField(nextTags), mapJsonField(nextMetadata), updatedAt, id)
    .run();

  return c.json({
    ok: true,
    id,
    image_url: candidate.poster_url,
    tmdb: candidate,
    metadata: nextMetadata,
    tags: nextTags,
    updated_at: updatedAt,
  });
});

app.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const query = c.req.query();
  const filters = createFilterBuilder();
  filters.clauses.push("id = ?");
  filters.params.push(id);
  addPublishedFilter(filters, query);

  const row = await c.env.DB.prepare(`SELECT * FROM shelf_items${buildWhereClause(filters)}`)
    .bind(...filters.params)
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
    `INSERT INTO shelf_items (
      type, title, quote, author, source, url, note, image_url, drawer, tags_json, date_added, published,
      status, rating, rating_scale, started_at, completed_at, last_watched_at, progress_current, progress_total,
      progress_unit, favorite_rank, showcase, metadata_json,
      shelf_group, display_order, cover_override_url, spine_image_url, goodreads_id, isbn, apple_books_id,
      created_at, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      validation.data.published === false ? 0 : 1,
      ...shelfStateParams(validation.data),
      ...shelfControlParams(validation.data),
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
     SET type = ?, title = ?, quote = ?, author = ?, source = ?, url = ?, note = ?, image_url = ?, drawer = ?, tags_json = ?, date_added = ?, published = ?,
       status = ?, rating = ?, rating_scale = ?, started_at = ?, completed_at = ?, last_watched_at = ?, progress_current = ?, progress_total = ?,
       progress_unit = ?, favorite_rank = ?, showcase = ?, metadata_json = ?,
       shelf_group = ?, display_order = ?, cover_override_url = ?, spine_image_url = ?, goodreads_id = ?, isbn = ?, apple_books_id = ?,
       updated_at = ?
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
      validation.data.published === false ? 0 : 1,
      ...shelfStateParams(validation.data),
      ...shelfControlParams(validation.data),
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

  if (
    Object.prototype.hasOwnProperty.call(validation.data, "status") ||
    Object.prototype.hasOwnProperty.call(validation.data, "type")
  ) {
    const existing = await c.env.DB.prepare("SELECT type, status FROM shelf_items WHERE id = ?")
      .bind(id)
      .first<JsonRecord>();

    if (!existing) {
      return c.json({ error: "Shelf item not found" }, 404);
    }

    const nextType = validation.data.type ?? String(existing.type ?? "");
    const nextStatus =
      validation.data.status ??
      (typeof existing.status === "string" ? existing.status : undefined);

    if (nextStatus && !statusMatchesShelfType(nextType, nextStatus)) {
      return c.json({ error: `Invalid ${nextType} shelf status: ${nextStatus}` }, 400);
    }
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
  if (Object.prototype.hasOwnProperty.call(validation.data, "published")) {
    updates.push("published = ?");
    params.push(validation.data.published === false ? 0 : 1);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "status")) {
    updates.push("status = ?");
    params.push(validation.data.status ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "rating")) {
    updates.push("rating = ?");
    params.push(validation.data.rating ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "rating_scale")) {
    updates.push("rating_scale = ?");
    params.push(validation.data.rating_scale ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "started_at")) {
    updates.push("started_at = ?");
    params.push(validation.data.started_at ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "completed_at")) {
    updates.push("completed_at = ?");
    params.push(validation.data.completed_at ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "last_watched_at")) {
    updates.push("last_watched_at = ?");
    params.push(validation.data.last_watched_at ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "progress_current")) {
    updates.push("progress_current = ?");
    params.push(validation.data.progress_current ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "progress_total")) {
    updates.push("progress_total = ?");
    params.push(validation.data.progress_total ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "progress_unit")) {
    updates.push("progress_unit = ?");
    params.push(validation.data.progress_unit ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "favorite_rank")) {
    updates.push("favorite_rank = ?");
    params.push(validation.data.favorite_rank ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "showcase")) {
    updates.push("showcase = ?");
    params.push(validation.data.showcase === true ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "metadata")) {
    updates.push("metadata_json = ?");
    params.push(mapJsonField(validation.data.metadata));
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "shelf_group")) {
    updates.push("shelf_group = ?");
    params.push(validation.data.shelf_group ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "display_order")) {
    updates.push("display_order = ?");
    params.push(validation.data.display_order ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "cover_override_url")) {
    updates.push("cover_override_url = ?");
    params.push(validation.data.cover_override_url ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "spine_image_url")) {
    updates.push("spine_image_url = ?");
    params.push(validation.data.spine_image_url ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "goodreads_id")) {
    updates.push("goodreads_id = ?");
    params.push(validation.data.goodreads_id ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "isbn")) {
    updates.push("isbn = ?");
    params.push(validation.data.isbn ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "apple_books_id")) {
    updates.push("apple_books_id = ?");
    params.push(validation.data.apple_books_id ?? null);
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
