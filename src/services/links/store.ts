import type { Env } from "../../types/env";
import { DocumentError, type DocumentRow } from "../documents";
import { linkKind } from "./urls";

// A saved link's row (documents + links + link_reading), how replies show it, and the reads.

export interface LinkRow extends DocumentRow {
  url: string; site: string | null; excerpt: string | null; reading_minutes: number | null;
  read_at: string | null; fetched_at: string | null; fetch_error: string | null;
  // From link_reading (null until the link is first opened or noted).
  progress: number | null; progress_anchor: string | null; progress_updated_at: string | null;
  progress_device: string | null; opened_at: string | null; note: string | null; note_updated_at: string | null;
}

function meta(row: { frontmatter_json: string | null }): { image?: string; icon?: string; starred_at?: string; tags?: string[] } {
  try { return row.frontmatter_json ? JSON.parse(row.frontmatter_json) : {}; } catch { return {}; }
}

export function presentLink(row: LinkRow, includeBody = false) {
  return {
    id: row.id, title: row.title, url: row.url, site: row.site, excerpt: row.excerpt,
    reading_minutes: row.reading_minutes, read_at: row.read_at, fetched_at: row.fetched_at,
    image_url: meta(row).image ?? null, icon_url: meta(row).icon ?? null,
    starred_at: meta(row).starred_at ?? null, tags: meta(row).tags ?? [],
    fetch_error: row.fetch_error, visibility: row.visibility, created_at: row.created_at,
    updated_at: row.updated_at, version: row.version,
    // Added with link_reading (0036). Archived is read_at, under its plan name.
    state: row.read_at ? "archived" as const : "inbox" as const, archived_at: row.read_at,
    kind: linkKind(row.url, row.fetch_error),
    progress: row.progress ?? 0, progress_anchor: row.progress_anchor ?? null,
    progress_updated_at: row.progress_updated_at ?? null, progress_device: row.progress_device ?? null,
    opened_at: row.opened_at ?? null, note: row.note ?? null, note_updated_at: row.note_updated_at ?? null,
    ...(includeBody ? { body: row.body } : {}),
  };
}

const SELECT = `SELECT d.*, l.url, l.site, l.excerpt, l.reading_minutes, l.read_at, l.fetched_at, l.fetch_error,
  r.progress, r.progress_anchor, r.progress_updated_at, r.progress_device, r.opened_at, r.note, r.note_updated_at
  FROM links l JOIN documents d ON d.id = l.document_id
  LEFT JOIN link_reading r ON r.document_id = l.document_id`;

/** The same, without the article body: lists never show it, and bodies are most of the bytes. */
const LIST_SELECT = `SELECT d.id, d.kind, d.folder, d.title, d.slug, d.frontmatter_json, d.visibility, d.status, d.post_id,
  d.source, d.created_at, d.updated_at, d.version, d.deleted_at,
  l.url, l.site, l.excerpt, l.reading_minutes, l.read_at, l.fetched_at, l.fetch_error,
  r.progress, r.progress_anchor, r.progress_updated_at, r.progress_device, r.opened_at, r.note, r.note_updated_at
  FROM links l JOIN documents d ON d.id = l.document_id
  LEFT JOIN link_reading r ON r.document_id = l.document_id`;

export async function getLink(env: Env, id: string): Promise<LinkRow> {
  const row = await env.DB.prepare(`${SELECT} WHERE d.id = ? AND d.deleted_at IS NULL`).bind(id).first<LinkRow>();
  if (!row) throw new DocumentError("Link not found", 404);
  return row;
}

export type LinkListState = "unread" | "read" | "starred" | "all" | "inbox" | "archived";

/**
 * Saved links, newest first: `limit + 1` of them, so the caller can tell another page follows.
 * `inbox` is `unread` and `archived` is `read` under their plan names. `after` is the last page's [created_at, id].
 */
export async function listLinks(env: Env, state: LinkListState = "all", limit = 500, tag?: string, after?: [string, string] | null): Promise<LinkRow[]> {
  const filter = state === "unread" || state === "inbox" ? " AND l.read_at IS NULL"
    : state === "read" || state === "archived" ? " AND l.read_at IS NOT NULL"
    : state === "starred" ? " AND json_extract(d.frontmatter_json, '$.starred_at') IS NOT NULL" : "";
  const tagFilter = tag ? " AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(d.frontmatter_json, '$.tags'), '[]')) t WHERE t.value = ?)" : "";
  const binds: unknown[] = tag ? [tag.trim().toLowerCase()] : [];
  const afterFilter = after ? " AND (d.created_at < ? OR (d.created_at = ? AND d.id < ?))" : "";
  if (after) binds.push(after[0], after[0], after[1]);
  const { results } = await env.DB.prepare(
    `${LIST_SELECT} WHERE d.deleted_at IS NULL${filter}${tagFilter}${afterFilter} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
  ).bind(...binds, Math.min(Math.max(limit, 1), 2000) + 1).all<LinkRow>();
  return results;
}

/** Every tag on a saved link, with how many links carry it (most used first). */
export async function linkTags(env: Env): Promise<Array<{ tag: string; count: number; inbox: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT t.value AS tag, COUNT(*) AS count, SUM(CASE WHEN l.read_at IS NULL THEN 1 ELSE 0 END) AS inbox
     FROM links l JOIN documents d ON d.id = l.document_id,
       json_each(COALESCE(json_extract(d.frontmatter_json, '$.tags'), '[]')) t
     WHERE d.deleted_at IS NULL AND d.kind = 'link' AND t.type = 'text'
     GROUP BY t.value ORDER BY count DESC, tag ASC`,
  ).all<{ tag: string; count: number; inbox: number }>();
  return results.map((r) => ({ tag: r.tag, count: Number(r.count), inbox: Number(r.inbox) }));
}
