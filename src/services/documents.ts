import type { Env } from "../types/env";
import {
  type DocumentKind,
  type DocumentStatus,
  type Visibility,
  KINDS,
  VISIBILITIES,
  slugify,
  ulid,
} from "./documents-core";

export interface DocumentRow {
  id: string;
  kind: DocumentKind;
  folder: string;
  title: string;
  slug: string;
  body: string;
  frontmatter_json: string | null;
  visibility: Visibility;
  status: DocumentStatus | null;
  post_id: number | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  deleted_at: string | null;
}

export class DocumentError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

const LIST_COLUMNS = "id, kind, folder, title, slug, visibility, status, post_id, source, created_at, updated_at, version";

export function present(row: DocumentRow, includeBody = true) {
  return {
    id: row.id,
    kind: row.kind,
    folder: row.folder,
    title: row.title,
    slug: row.slug,
    ...(includeBody ? { body: row.body, frontmatter: row.frontmatter_json ? JSON.parse(row.frontmatter_json) : {} } : {}),
    visibility: row.visibility,
    status: row.status,
    post_id: row.post_id,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/**
 * Documents, most recently updated first: `limit + 1` of them, so the caller
 * can tell another page follows. `after` is the last page's [updated_at, id].
 */
export async function listDocuments(env: Env, query: {
  kind?: string; folder?: string; updatedSince?: string; includeBody?: boolean; includeDeleted?: boolean; limit?: number;
  after?: [string, string] | null;
}) {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!query.includeDeleted) where.push("deleted_at IS NULL");
  if (query.kind && (KINDS as string[]).includes(query.kind)) { where.push("kind = ?"); binds.push(query.kind); }
  if (query.folder !== undefined) { where.push("folder = ?"); binds.push(query.folder); }
  if (query.updatedSince) { where.push("updated_at > ?"); binds.push(query.updatedSince); }
  if (query.after) { where.push("(updated_at < ? OR (updated_at = ? AND id < ?))"); binds.push(query.after[0], query.after[0], query.after[1]); }
  const columns = query.includeBody ? "*" : LIST_COLUMNS;
  const limit = Math.min(Math.max(query.limit ?? 2000, 1), 5000) + 1;
  const sql = `SELECT ${columns}${query.includeDeleted ? ", deleted_at" : ""} FROM documents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<DocumentRow>();
  return results;
}

export async function getDocument(env: Env, id: string): Promise<DocumentRow> {
  const row = await env.DB.prepare("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL").bind(id).first<DocumentRow>();
  if (!row) throw new DocumentError("Document not found", 404);
  return row;
}

async function uniqueSlug(env: Env, base: string): Promise<string> {
  let slug = base;
  for (let n = 2; n < 500; n++) {
    const taken = await env.DB.prepare("SELECT 1 FROM documents WHERE slug = ?").bind(slug).first();
    if (!taken) return slug;
    slug = `${base}-${n}`;
  }
  return `${base}-${ulid().slice(-6).toLowerCase()}`;
}

export interface DocumentInput {
  kind?: unknown; title?: unknown; body?: unknown; folder?: unknown;
  frontmatter?: unknown; visibility?: unknown; status?: unknown; version?: unknown;
}

function asString(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new DocumentError(`${field} must be a string under ${max} characters`, 400);
  return value;
}

export async function createDocument(env: Env, input: DocumentInput, now = new Date()): Promise<DocumentRow> {
  const kind = (input.kind ?? "note") as DocumentKind;
  if (!KINDS.includes(kind)) throw new DocumentError("Unknown kind", 400);
  const title = asString(input.title, 300, "title")?.trim() || (kind === "journal" ? now.toISOString().slice(0, 10) : "Untitled");
  const body = asString(input.body, 1_000_000, "body") ?? "";
  const folder = asString(input.folder, 200, "folder") ?? (kind === "journal" ? "Journal" : kind === "writing" ? "Writing" : "");
  let visibility = (input.visibility ?? (kind === "journal" ? "locked" : "private")) as Visibility;
  if (!VISIBILITIES.includes(visibility)) throw new DocumentError("Unknown visibility", 400);
  if (kind === "journal") visibility = "locked";
  const status: DocumentStatus | null = kind === "writing" ? "draft" : null;
  const frontmatter = input.frontmatter && typeof input.frontmatter === "object" ? JSON.stringify(input.frontmatter) : null;

  const id = ulid(now.getTime());
  const slug = await uniqueSlug(env, slugify(title));
  const stamp = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO documents (id, kind, folder, title, slug, body, frontmatter_json, visibility, status, post_id, source, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1)`,
  ).bind(id, kind, folder, title, slug, body, frontmatter, visibility, status, stamp, stamp).run();
  return getDocument(env, id);
}

/**
 * Saves with optimistic concurrency: `version` must be the one you loaded.
 * The previous version is kept in document_versions first.
 */
export async function saveDocument(env: Env, id: string, input: DocumentInput, now = new Date()): Promise<DocumentRow> {
  const expected = typeof input.version === "number" ? input.version : NaN;
  if (!Number.isInteger(expected)) throw new DocumentError("version is required (the one you loaded)", 400);
  const current = await getDocument(env, id);
  if (current.version !== expected) throw new DocumentError("This document changed since you loaded it", 409);

  const title = asString(input.title, 300, "title")?.trim() || current.title;
  const body = asString(input.body, 1_000_000, "body") ?? current.body;
  const folder = asString(input.folder, 200, "folder") ?? current.folder;

  // A page can change what it is: note, journal or writing. Live writing has to
  // be unpublished first, so nothing disappears from the site by accident.
  const kind = (input.kind ?? current.kind) as DocumentKind;
  const pages: DocumentKind[] = ["note", "journal", "writing"];
  if (kind !== current.kind && (!pages.includes(kind) || !pages.includes(current.kind))) {
    throw new DocumentError("Only notes, journal entries and writing can change into each other", 400);
  }
  if (kind !== current.kind && current.kind === "writing" && current.status === "published") {
    throw new DocumentError("Unpublish this piece before changing what it is", 400);
  }
  const status: DocumentStatus | null = kind === current.kind ? current.status : kind === "writing" ? "draft" : null;

  let visibility = (input.visibility ?? current.visibility) as Visibility;
  if (!VISIBILITIES.includes(visibility)) throw new DocumentError("Unknown visibility", 400);
  if (kind === "journal") visibility = "locked";
  else if (current.kind === "journal" && visibility === "locked") visibility = "private";
  if (kind !== "writing" && visibility === "public") visibility = "agents";
  const frontmatter = input.frontmatter && typeof input.frontmatter === "object"
    ? JSON.stringify(input.frontmatter) : current.frontmatter_json;
  const stamp = now.toISOString();

  const [, update] = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO document_versions (document_id, version, title, body, frontmatter_json, saved_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, current.version, current.title, current.body, current.frontmatter_json, current.updated_at),
    env.DB.prepare(
      `UPDATE documents SET kind = ?, status = ?, title = ?, body = ?, folder = ?, visibility = ?, frontmatter_json = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    ).bind(kind, status, title, body, folder, visibility, frontmatter, stamp, id, expected),
  ]);
  // Only one row can match (id + version); the search index trigger adds its own rows to the count, so test for none.
  if ((update.meta?.changes ?? 0) === 0) throw new DocumentError("This document changed since you loaded it", 409);
  const saved = await getDocument(env, id);
  if (saved.kind === "writing" && saved.status === "published" && saved.post_id) await syncPost(env, saved, true, now);
  return saved;
}

export async function deleteDocument(env: Env, id: string, now = new Date()) {
  const result = await env.DB.prepare("UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(now.toISOString(), now.toISOString(), id).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new DocumentError("Document not found", 404);
}

/** First paragraph of plain text, for the post summary. */
export function summarize(body: string): string | null {
  const paragraph = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#") && !p.startsWith("!["));
  if (!paragraph) return null;
  const text = paragraph.replace(/[*_`>#\[\]]/g, "").replace(/\s+/g, " ").trim();
  return text.length > 220 ? text.slice(0, 217).trimEnd() + "…" : text;
}

/** Body without a leading `# Title` line, which the site renders separately. */
export function postContent(body: string): string {
  return body.replace(/^#\s+.*\n+/, "");
}

/**
 * The writes that create or update the site's post for a piece of writing,
 * and SQL for that post's id (usable in the same batch, before the insert has
 * an id to hand back). Reads first: whether the post still exists, and
 * whether the slug is taken.
 */
async function postWrites(env: Env, doc: DocumentRow, published: boolean, now: Date) {
  const stamp = now.toISOString();
  const live = doc.post_id ? await env.DB.prepare("SELECT id FROM posts WHERE id = ?").bind(doc.post_id).first<{ id: number }>() : null;
  if (live) {
    return {
      statements: [env.DB.prepare(
        `UPDATE posts SET title = ?, summary = COALESCE(?, summary), content = ?,
           published_at = CASE WHEN ? THEN COALESCE(published_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?`,
      ).bind(doc.title, summarize(doc.body), postContent(doc.body), published ? 1 : 0, stamp, stamp, live.id)],
      postId: { sql: "?", args: [live.id] as unknown[] },
    };
  }
  let slug = doc.slug;
  const clash = await env.DB.prepare("SELECT id FROM posts WHERE slug = ?").bind(slug).first<{ id: number }>();
  if (clash) slug = `${slug}-${doc.id.slice(-4).toLowerCase()}`;
  return {
    statements: [env.DB.prepare(
      `INSERT INTO posts (slug, title, summary, content, tags_json, published_at, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
    ).bind(slug, doc.title, summarize(doc.body), postContent(doc.body), published ? stamp : null, stamp, stamp)],
    postId: { sql: "(SELECT id FROM posts WHERE slug = ?)", args: [slug] as unknown[] },
  };
}

/** Creates or updates the site's post for a piece of writing. */
async function syncPost(env: Env, doc: DocumentRow, published: boolean, now: Date): Promise<void> {
  const { statements } = await postWrites(env, doc, published, now);
  await env.DB.batch(statements);
}

/**
 * Publishing puts the writing on anuragd.me through the posts table the site
 * already reads. The post and the document change in one batch, so a failure
 * never leaves a post the document doesn't know about.
 */
export async function setPublished(env: Env, id: string, published: boolean, now = new Date()): Promise<DocumentRow> {
  const doc = await getDocument(env, id);
  if (doc.kind !== "writing") throw new DocumentError("Only writing can be published", 400);
  if (!published && !doc.post_id) return doc;
  const { statements, postId } = await postWrites(env, doc, published, now);
  await env.DB.batch([
    ...statements,
    env.DB.prepare(
      `UPDATE documents SET status = ?, visibility = ?, post_id = ${postId.sql}, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).bind(published ? "published" : "draft", published ? "public" : "agents", ...postId.args, now.toISOString(), id),
  ]);
  return getDocument(env, id);
}

export async function searchDocuments(env: Env, q: string, limit = 30) {
  const terms = q.replace(/["*()^:]/g, " ").split(/\s+/).filter(Boolean).slice(0, 8);
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t}"*`).join(" ");
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.kind, d.folder, d.title, d.slug, d.visibility, d.status, d.updated_at,
            snippet(documents_fts, 1, '[', ']', '…', 12) AS snippet
       FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH ? AND d.deleted_at IS NULL
      ORDER BY rank LIMIT ?`,
  ).bind(match, Math.min(limit, 100)).all();
  return results;
}

export const INBOX_FOLDER = "Inbox";

/**
 * A capture becomes its own note in the Inbox section: the first line is the
 * title, the rest is the body. Sort it, move it or turn it into writing later.
 */
export async function captureToInbox(env: Env, text: string, now = new Date()): Promise<DocumentRow> {
  const trimmed = text.trim();
  if (!trimmed) throw new DocumentError("text is required", 400);
  const [first, ...rest] = trimmed.split("\n");
  const line = first.replace(/^#+\s*/, "").trim();
  const title = line.length > 80 ? line.slice(0, 77).trimEnd() + "…" : line;
  const remainder = (line.length > 80 ? trimmed : rest.join("\n")).trim();
  const body = `# ${title}\n\n${remainder}${remainder ? "\n" : ""}`;
  return createDocument(env, { kind: "note", title, body, folder: INBOX_FOLDER }, now);
}
