import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizeShelfItem } from "../utils/normalizers";
import {
  describedFields,
  shelfItemBaseSchema,
  shelfItemSchema,
  shelfLogPatchObject,
  shelfLogSchema,
  statusMatchesShelfType,
} from "../schemas/content";
import { shelfResponseSchema } from "../schemas/responses";
import { listQuerySchema } from "../schemas/common";
import { getTmdbMedia, normalizeTmdbMediaType, searchTmdbMedia, type TmdbCandidate } from "../services/tmdb";
import { getTag, mergeTags } from "../utils/tags";
import { isJsonRecord, normalizeTmdbMetadata, shouldReplaceShelfImage } from "../services/shelf-enrich";
import diaryRoute from "./shelf-diary";
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

const app = new Hono<{ Bindings: Env }>();

// A PATCH may also clear a field with null (a rating, a date, a note).
const clearable = shelfItemBaseSchema.shape;
const shelfPatchObject = shelfItemBaseSchema
  .extend({
    author: clearable.author.unwrap().nullable(),
    note: clearable.note.unwrap().nullable(),
    rating: clearable.rating.unwrap().nullable(),
    rating_scale: clearable.rating_scale.unwrap().nullable(),
    started_at: clearable.started_at.unwrap().nullable(),
    completed_at: clearable.completed_at.unwrap().nullable(),
    last_watched_at: clearable.last_watched_at.unwrap().nullable(),
    progress_current: clearable.progress_current.unwrap().nullable(),
    progress_total: clearable.progress_total.unwrap().nullable(),
    progress_unit: clearable.progress_unit.unwrap().nullable(),
    status: clearable.status.unwrap().nullable(),
  })
  .partial();
const shelfPatchSchema = shelfPatchObject.refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// Request-only schemas (no response extends them), so their notes sit on the fields.
const shelfEnrichSchema = z.object({
  tmdb_id: z.number().int().positive().optional().openapi({ description: "The TMDB id, when you know it. Otherwise the item's title (or `title`) is searched" }),
  tmdb_media_type: z.enum(["movie", "tv"]).optional().openapi({ description: "movie or tv. Defaults from the item's type" }),
  title: z.string().optional().openapi({ description: "A title to search instead of the item's" }),
  year: z.string().optional().openapi({ description: "Release year, to tell remakes apart" }),
});

const shelfQuerySchema = listQuerySchema.extend({
  type: z
    .string()
    .optional()
    .describe(
      'One type ("book", "movie", "show", "anime", "quote", ...), a comma list, or "all". ' +
        'Without it every type except "anime" is listed, exactly as before anime existed.'
    ),
});

const shelfDiaryQuerySchema = listQuerySchema.extend({
  type: z.string().optional().openapi({ description: "book, movie, show or anime, or a comma list" }),
  item_id: z.string().optional().openapi({ description: "One item's diary" }),
  kind: z.string().optional().openapi({ description: "Log kinds, comma list: started, progress, finished, paused, dropped, want, rated, note" }),
});

/**
 * Types left out of an unfiltered GET /v1/shelf. The public site reads the
 * shelf without a type and sorts items into its own sections; "anime" is new
 * and only the apps know it, so it stays out of that default list and is
 * returned only when asked for (type=anime, a list naming it, or type=all).
 */
const OPT_IN_TYPES = ["anime"];

const SHELF_TYPE_PATTERN = /^[a-z_]{1,32}$/;

function addShelfTypeFilter(filters: ReturnType<typeof createFilterBuilder>, raw: string | undefined) {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    filters.clauses.push(`type NOT IN (${OPT_IN_TYPES.map(() => "?").join(", ")})`);
    filters.params.push(...OPT_IN_TYPES);
    return;
  }
  if (value === "all") return;
  const types = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
  if (types.length === 1) {
    // Exactly the old behaviour for a single type (raw value, as the site sends it).
    filters.clauses.push("type = ?");
    filters.params.push(raw!.includes(",") ? types[0] : raw!);
    return;
  }
  const safe = types.filter((type) => SHELF_TYPE_PATTERN.test(type));
  if (safe.length === 0) {
    filters.clauses.push("1 = 0");
    return;
  }
  filters.clauses.push(`type IN (${safe.map(() => "?").join(", ")})`);
  filters.params.push(...safe);
}

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

// OpenAPI registrations
const TAG = "Shelf";
apiTags.push({
  name: TAG,
  description: `The Library and anuragd.me/shelf. Books, movies, shows and anime are tracked here, each with a diary of \
starts, progress and finishes. The shelf also holds the site's collections: quotes (\`type\` quote), links (article), \
visuals (visual) and wallpapers (wallpaper).

**Public or private.** An item with \`published: true\` is on anuragd.me/shelf. \`published\` defaults to **true** when it \
is left out, on POST and on PUT, so always send \`published: false\` (the app does the same). Agents add items hidden. Only \
the owner puts one on the site, after a two-step confirm: show the item as it will appear, get a yes, then confirm once \
more. GET /v1/shelf and GET /v1/shelf/{id} return published items only; add \`include_unpublished=1\` to see hidden ones. \
The website's token may only call GET /v1/shelf, without that flag. Without \`type\` it leaves out anime, so the site never \
lists anime. The diary (GET /v1/shelf/diary) is not read by the site, but a log moves the item itself (status, progress, \
rating, dates), and a published item shows that change.

**Order of calls.** 1. Check it isn't already there: GET /v1/shelf?type=book&include_unpublished=1&search=<title>. \
2. For a movie or show, look it up first with GET /v1/media/search?type=movie&q=<title> (TMDB) and keep its poster and \
ids. 3. POST /v1/shelf with \`published: false\`; the reply has the new \`id\`. 4. Record what happened with POST \
/v1/shelf/{id}/log (started, progress, finished, …): it writes the diary and moves the item's status in one call. Prefer a \
log to setting \`status\` or \`completed_at\` by hand, so the diary has the entry. POST /v1/shelf/{id}/enrich fills a \
movie or show's poster and TMDB details later.

**Statuses** (they must fit the type). Books: library, reading, completed, want_to_read, paused, dnf. Movies: watched, \
watching, want_to_watch. Shows and anime: watching, completed, want_to_watch, paused, dropped.

**Uploads.** None. \`image_url\` and the other image fields are stored as the link you give; they are not copied into this \
API's storage.

**Avoid.** PUT replaces every field: a PUT without \`published\` publishes the item, and one without \`date_added\` clears \
it. Use PATCH with only the fields you change (null clears a rating, date or note). Only log a finish or rating the owner \
told you about. DELETE removes the item and its diary for good.`,
});
// The request bodies with their field notes. shelfItemBaseSchema is also the base of the shelf
// response, so the notes are on doc-only copies used here and nowhere else.
const shelfFieldDocs = {
  type: "book, movie, show or anime (tracked, with a diary); quote, article, visual or wallpaper (the site's collections)",
  title: "The work's title. Not needed for a quote",
  quote: "For a quote: the words",
  author: "Book author, or who said the quote",
  source: "For a quote or link: where it is from (a book, a site)",
  url: "For a link: the page. Otherwise optional",
  note: "The owner's own note on it",
  image_url: "Cover or poster: a public image link, stored as given",
  drawer: "Which shelf section a movie or show sits in on the site: movies or shows. Leave it out otherwise",
  tags: "A list of strings. Lookups add key:value tags like \"tmdb_id:603\" and \"year:1999\"",
  date_added: "When it was added (ISO 8601). Defaults to now on POST",
  published: "true puts the item on anuragd.me/shelf. Defaults to true when left out: agents always send false. Only the owner publishes",
  status: "Where it stands; must fit the type (see the Shelf guide). Prefer POST /v1/shelf/{id}/log to change it",
  rating: "Only the owner's own rating, never one from a review site. Read with `rating_scale`",
  rating_scale: "5 or 10: what `rating` is out of",
  started_at: "ISO 8601. A log sets it",
  completed_at: "ISO 8601. A finish log sets it",
  last_watched_at: "Movies, shows, anime: ISO 8601. A log sets it",
  progress_current: "Where you are, in `progress_unit`",
  progress_total: "Pages or episodes in all",
  progress_unit: "\"page\" for books, \"episode\" for shows and anime (as the app sends)",
  favorite_rank: "1 is the top favorite; the site orders favorites by it. Owner's choice",
  showcase: "Puts it forward on the site. Owner's choice",
  shelf_group: "A named group on the site's bookshelf",
  display_order: "Its place within the site's shelf",
  cover_override_url: "A cover to show instead of `image_url`",
  spine_image_url: "A book spine image for the site's bookshelf",
  goodreads_id: "Goodreads book id",
  isbn: "ISBN-10 or ISBN-13",
  apple_books_id: "Apple Books id",
  metadata: "Free-form details kept with the item: `tmdb` (from enrich), `seasons` (episode counts), `progress` (season, episode)",
} as const;
const shelfBodyDoc = describedFields(shelfItemBaseSchema, shelfFieldDocs);
const shelfPatchDoc = describedFields(shelfPatchObject, shelfFieldDocs).partial();
const shelfLogBodyDoc = describedFields(shelfLogSchema, {
  kind: "What happened. started, progress, finished, paused, dropped and want also move the item's `status` "
    + "(a finished book becomes completed, a finished movie watched). rated and note only write the diary, plus the rating if given",
  logged_at: "When it happened (ISO 8601). Defaults to now; give the real date for something in the past",
  status: "Only to override the status `kind` gives. Must fit the item's type",
  progress_current: "Where you are now. A finish without it is set to the total",
  progress_total: "Pages or episodes in all",
  progress_unit: "\"page\" or \"episode\"",
  season: "Shows and anime: the season you're on",
  episode: "Shows and anime: the episode you're on",
  rating: "Only the owner's own rating. Also sets the item's rating",
  rating_scale: "5 or 10. Defaults to the item's scale, else 5",
  note: "A line about it, in the owner's words",
  rewatch: "A reread or rewatch of something already finished",
});
const shelfLogPatchDoc = describedFields(shelfLogPatchObject, {
  logged_at: "ISO 8601",
  rating: "null clears it. The item's own rating is not changed",
  note: "null clears it",
  rewatch: "A reread or rewatch",
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/shelf",
  tags: [TAG],
  summary: "List shelf items",
  security: authSecurity,
  request: { query: shelfQuerySchema },
  responses: okResponses(shelfResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/shelf/{id}",
  tags: [TAG],
  summary: "Get shelf item",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/shelf",
  tags: [TAG],
  summary: "Create shelf item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfBodyDoc) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/shelf/{id}",
  tags: [TAG],
  summary: "Update shelf item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfBodyDoc) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/shelf/{id}",
  tags: [TAG],
  summary: "Patch shelf item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfPatchDoc) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/shelf/{id}",
  tags: [TAG],
  summary: "Delete shelf item",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/shelf/{id}/enrich",
  tags: [TAG],
  summary: "Enrich shelf item with TMDB poster metadata",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfEnrichSchema) },
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/shelf/diary",
  tags: [TAG],
  summary: "The Library diary: every start, update and finish, newest first",
  security: authSecurity,
  request: { query: shelfDiaryQuerySchema },
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/shelf/{id}/log",
  tags: [TAG],
  summary: "Log a start, progress, finish, pause, drop or rating; updates the item and writes the diary",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfLogBodyDoc) },
  responses: createdResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/shelf/log/{logId}",
  tags: [TAG],
  summary: "Fix a diary entry (date, rating, note, rewatch)",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfLogPatchDoc) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/shelf/log/{logId}",
  tags: [TAG],
  summary: "Delete a diary entry (the item itself stays)",
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
  addPublishedFilter(filters, query);

  addShelfTypeFilter(filters, query.type);

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

// The diary: /diary, /log/:logId and /:id/log, before /:id below.
app.route("/", diaryRoute);

app.post("/:id/enrich", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const body = await parseJson(c.req.raw);
  const validation = body === null ? shelfEnrichSchema.safeParse({}) : shelfEnrichSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: validation.error.issues[0]?.message ?? "Invalid body" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM shelf_items WHERE id = ?")
    .bind(id)
    .all();
  if (!row.results || row.results.length === 0) {
    return notFound(c, "Shelf item");
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
  const nextImageUrl = shouldReplaceShelfImage(item, tags)
    ? candidate.poster_url
    : String(item.image_url);

  await c.env.DB.prepare(
    `UPDATE shelf_items SET image_url = ?, tags_json = ?, metadata_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(nextImageUrl, mapJsonField(nextTags), mapJsonField(nextMetadata), updatedAt, id)
    .run();

  return c.json({
    ok: true,
    id,
    image_url: nextImageUrl,
    tmdb: candidate,
    metadata: nextMetadata,
    tags: nextTags,
    updated_at: updatedAt,
  });
});

app.get("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const query = c.req.query();
  const filters = createFilterBuilder();
  filters.clauses.push("id = ?");
  filters.params.push(id);
  addPublishedFilter(filters, query);

  const row = await c.env.DB.prepare(`SELECT * FROM shelf_items${buildWhereClause(filters)}`)
    .bind(...filters.params)
    .all();

  if (!row.results || row.results.length === 0) {
    return notFound(c, "Shelf item");
  }

  return c.json(normalizeShelfItem(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const validation = await readBody(c, shelfItemSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  const dateAdded = validation.data.date_added ?? createdAt;
  const insert = await c.env.DB.prepare(
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

  // The new id lets the apps log the item straight away ("finished it today").
  const newId = (insert as { meta?: { last_row_id?: number } })?.meta?.last_row_id;
  return c.json({ ok: true, ...(newId ? { id: newId } : {}), created_at: createdAt }, 201);
});

app.put("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, shelfItemSchema);
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
    return notFound(c, "Shelf item");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, shelfPatchSchema);
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
      return notFound(c, "Shelf item");
    }

    const nextType = validation.data.type ?? String(existing.type ?? "");
    const nextStatus =
      validation.data.status ??
      (typeof existing.status === "string" ? existing.status : undefined);

    if (nextStatus && !statusMatchesShelfType(nextType, nextStatus)) {
      return c.json({ error: `Invalid ${nextType} shelf status: ${nextStatus}` }, 400);
    }
  }

  const { sets: updates, params } = patchAssignments(validation.data, {
    type: true,
    title: true,
    quote: true,
    author: true,
    source: true,
    url: true,
    note: true,
    image_url: true,
    drawer: true,
    tags: { column: "tags_json", to: mapJsonField },
    date_added: true,
    published: { to: publishedFlag },
    status: true,
    rating: true,
    rating_scale: true,
    started_at: true,
    completed_at: true,
    last_watched_at: true,
    progress_current: true,
    progress_total: true,
    progress_unit: true,
    favorite_rank: true,
    showcase: { to: (value) => value === true ? 1 : 0 },
    metadata: { column: "metadata_json", to: mapJsonField },
    shelf_group: true,
    display_order: true,
    cover_override_url: true,
    spine_image_url: true,
    goodreads_id: true,
    isbn: true,
    apple_books_id: true,
  });

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE shelf_items SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return notFound(c, "Shelf item");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const result = await c.env.DB.prepare("DELETE FROM shelf_items WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Shelf item");
  }

  // Its diary goes with it (the diary only lists entries whose item exists anyway).
  await c.env.DB.prepare("DELETE FROM shelf_log WHERE item_id = ?").bind(id).run().catch(() => undefined);

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
