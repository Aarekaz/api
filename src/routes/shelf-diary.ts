import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizeShelfItem } from "../utils/normalizers";
import {
  SHELF_MEDIA_TYPES,
  activeStatusFor,
  finishedStatusFor,
  queuedStatusFor,
  shelfLogPatchSchema,
  shelfLogSchema,
  statusMatchesShelfType,
  stoppedStatusFor,
} from "../schemas/content";
import { parseListQuery, parseId } from "../utils/query";
import { compactRecord, isJsonRecord, parseStoredRecord } from "../services/shelf-enrich";

// The shelf's diary: what you started, finished, rated or noted, and when.
// Mounted by routes/shelf.ts before its /:id routes (so /diary and /log/:logId
// match first); its OpenAPI paths are registered there with the rest.

const app = new Hono<{ Bindings: Env }>();

const DIARY_TYPES: readonly string[] = SHELF_MEDIA_TYPES;

function normalizeLogRow(row: JsonRecord): JsonRecord {
  const { rewatch, published, ...rest } = row;
  return {
    ...rest,
    rewatch: Boolean(rewatch),
    ...(published === undefined ? {} : { published: published == null ? true : Boolean(published) }),
  };
}

function shelfKind(type: string): string {
  const normalized = type.toLowerCase();
  if (normalized === "film") return "movie";
  if (normalized === "tv" || normalized === "series") return "show";
  return normalized;
}

function statusForLog(type: string, kind: string): string | null {
  switch (kind) {
    case "started":
    case "progress":
      return activeStatusFor(type);
    case "finished":
      return finishedStatusFor(type);
    case "paused":
      return stoppedStatusFor(type, "paused");
    case "dropped":
      return stoppedStatusFor(type, "dropped");
    case "want":
      return queuedStatusFor(type);
    default:
      return null;
  }
}

app.get("/diary", async (c) => {
  const query = c.req.query();
  const { limit, offset, start, end } = parseListQuery(query);
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const itemId = query.item_id ? parseId(query.item_id) : null;
  if (query.item_id && !itemId) return c.json({ error: "Invalid item_id" }, 400);
  if (itemId) {
    clauses.push("l.item_id = ?");
    params.push(itemId);
  }
  const types = (query.type ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter((part) => DIARY_TYPES.includes(part));
  if (types.length > 0) {
    clauses.push(`s.type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }
  const kinds = (query.kind ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => (shelfLogSchema.shape.kind.options as readonly string[]).includes(part));
  if (kinds.length > 0) {
    clauses.push(`l.kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  if (start) {
    clauses.push("l.logged_at >= ?");
    params.push(start);
  }
  if (end) {
    clauses.push("l.logged_at <= ?");
    params.push(end);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = await c.env.DB.prepare(
    `SELECT l.*, s.type AS type, s.title AS title, s.author AS author, s.image_url AS image_url,
       s.cover_override_url AS cover_override_url, s.status AS item_status, s.published AS published
     FROM shelf_log l JOIN shelf_items s ON s.id = l.item_id${where}
     ORDER BY l.logged_at DESC, l.id DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all();

  return c.json({
    items: (rows.results ?? []).map((row) => normalizeLogRow(row as JsonRecord)),
    limit,
    offset,
  });
});

app.patch("/log/:logId", async (c) => {
  const logId = idParam(c, "logId");
  if (!logId) return badId(c);
  const validation = await readBody(c, shelfLogPatchSchema);
  if (!validation.ok) return validation.response;

  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  const data = validation.data;
  if (data.logged_at !== undefined) {
    updates.push("logged_at = ?");
    params.push(data.logged_at);
  }
  if (data.rating !== undefined) {
    updates.push("rating = ?");
    params.push(data.rating);
  }
  if (data.note !== undefined) {
    updates.push("note = ?");
    params.push(data.note);
  }
  if (data.rewatch !== undefined) {
    updates.push("rewatch = ?");
    params.push(data.rewatch ? 1 : 0);
  }
  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt, logId);

  const result = await c.env.DB.prepare(`UPDATE shelf_log SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();
  if (result.meta.changes === 0) return notFound(c, "Diary entry");
  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/log/:logId", async (c) => {
  const logId = idParam(c, "logId");
  if (!logId) return badId(c);
  const result = await c.env.DB.prepare("DELETE FROM shelf_log WHERE id = ?").bind(logId).run();
  if (result.meta.changes === 0) return notFound(c, "Diary entry");
  return c.json({ ok: true, id: logId, deleted_at: nowIso() });
});

/**
 * Log something: "finished it", "on page 120", "watched S2 E5", "rated it".
 * Writes one diary row and moves the item along in the same call, so the
 * site (which reads shelf_items) updates by itself.
 */
app.post("/:id/log", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);
  const validation = await readBody(c, shelfLogSchema);
  if (!validation.ok) return validation.response;
  const data = validation.data;

  const existing = await c.env.DB.prepare("SELECT * FROM shelf_items WHERE id = ?").bind(id).first<JsonRecord>();
  if (!existing) return notFound(c, "Shelf item");

  const type = String(existing.type ?? "");
  if (!DIARY_TYPES.includes(shelfKind(type))) {
    return c.json({ error: "Only books, movies, shows and anime keep a diary" }, 400);
  }

  const status = data.status ?? statusForLog(type, data.kind);
  if (status && !statusMatchesShelfType(type, status)) {
    return c.json({ error: `Invalid ${type} shelf status: ${status}` }, 400);
  }

  const loggedAt = data.logged_at ?? nowIso();
  const updatedAt = nowIso();
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null) => {
    updates.push(`${column} = ?`);
    params.push(value);
  };

  if (status) set("status", status);

  const total = data.progress_total ?? (typeof existing.progress_total === "number" ? existing.progress_total : null);
  let current = data.progress_current ?? null;
  if (current === null && data.kind === "finished" && total !== null && total > 0 && !data.rewatch) current = total;
  if (current !== null) set("progress_current", current);
  if (data.progress_total !== undefined) set("progress_total", data.progress_total);
  if (data.progress_unit !== undefined) set("progress_unit", data.progress_unit);

  if (data.rating !== undefined) {
    set("rating", data.rating);
    set("rating_scale", data.rating_scale ?? (typeof existing.rating_scale === "number" ? existing.rating_scale : 5));
  }

  if (data.season !== undefined || data.episode !== undefined) {
    const metadata = parseStoredRecord(existing.metadata_json);
    const previous = isJsonRecord(metadata.progress) ? metadata.progress : {};
    metadata.progress = compactRecord({
      ...previous,
      season: data.season ?? previous.season,
      episode: data.episode ?? previous.episode,
      updated_at: loggedAt,
    });
    set("metadata_json", mapJsonField(metadata));
  }

  const isScreen = shelfKind(type) !== "book";
  if ((data.kind === "started" || data.kind === "progress" || data.kind === "finished") && !existing.started_at) {
    set("started_at", loggedAt);
  }
  if (data.kind === "finished") set("completed_at", loggedAt);
  if (isScreen && (data.kind === "progress" || data.kind === "finished" || data.kind === "started")) {
    set("last_watched_at", loggedAt);
  }

  set("updated_at", updatedAt);
  params.push(id);

  const insert = c.env.DB.prepare(
    `INSERT INTO shelf_log (item_id, kind, logged_at, status, progress_current, progress_total, progress_unit,
       season, episode, rating, note, rewatch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    data.kind,
    loggedAt,
    status ?? null,
    current,
    data.progress_total ?? null,
    data.progress_unit ?? null,
    data.season ?? null,
    data.episode ?? null,
    data.rating ?? null,
    data.note ?? null,
    data.rewatch ? 1 : 0,
    updatedAt
  );
  const update = c.env.DB.prepare(`UPDATE shelf_items SET ${updates.join(", ")} WHERE id = ?`).bind(...params);
  const [logResult] = (await c.env.DB.batch([insert, update])) as { meta: { last_row_id?: number } }[];

  const row = await c.env.DB.prepare("SELECT * FROM shelf_items WHERE id = ?").bind(id).first<JsonRecord>();
  return c.json(
    {
      ok: true,
      log_id: logResult?.meta?.last_row_id ?? null,
      logged_at: loggedAt,
      status: status ?? null,
      item: row ? normalizeShelfItem(row) : null,
    },
    201
  );
});

export default app;
