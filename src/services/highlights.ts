import type { Env } from "../types/env";
import { DocumentError } from "./documents";
import { ulid } from "./documents-core";

// Highlights: passages you mark while reading, with an optional note. They
// belong to a document (a saved link or a page) and collect into one list.

export interface HighlightRow {
  id: string; document_id: string; text: string; prefix: string | null; suffix: string | null;
  note: string | null; color: string | null; created_at: string; updated_at: string; deleted_at: string | null;
  title?: string; kind?: string; url?: string | null; site?: string | null;
}

export function presentHighlight(row: HighlightRow) {
  return {
    id: row.id, document_id: row.document_id, text: row.text, prefix: row.prefix, suffix: row.suffix,
    note: row.note, color: row.color, created_at: row.created_at, updated_at: row.updated_at,
    ...(row.title !== undefined ? { title: row.title, kind: row.kind, url: row.url ?? null, site: row.site ?? null } : {}),
  };
}

const SELECT = `SELECT h.*, d.title, d.kind, l.url, l.site FROM highlights h
  JOIN documents d ON d.id = h.document_id
  LEFT JOIN links l ON l.document_id = h.document_id`;

function text(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new DocumentError(`${field} is required`, 400);
    return null;
  }
  if (typeof value !== "string" || value.length > max) throw new DocumentError(`${field} must be a string under ${max} characters`, 400);
  const trimmed = value.trim();
  if (required && !trimmed) throw new DocumentError(`${field} is required`, 400);
  return trimmed || null;
}

export async function listHighlights(env: Env, documentId?: string, limit = 500) {
  const where = documentId ? "h.document_id = ? AND " : "";
  const binds: unknown[] = documentId ? [documentId] : [];
  const { results } = await env.DB.prepare(
    `${SELECT} WHERE ${where}h.deleted_at IS NULL AND d.deleted_at IS NULL ORDER BY h.created_at DESC LIMIT ?`,
  ).bind(...binds, Math.min(Math.max(limit, 1), 2000)).all<HighlightRow>();
  return results;
}

export async function getHighlight(env: Env, id: string): Promise<HighlightRow> {
  const row = await env.DB.prepare(`${SELECT} WHERE h.id = ? AND h.deleted_at IS NULL`).bind(id).first<HighlightRow>();
  if (!row) throw new DocumentError("Highlight not found", 404);
  return row;
}

export async function createHighlight(env: Env, input: Record<string, unknown>, now = new Date()): Promise<HighlightRow> {
  const documentId = text(input.document_id, "document_id", 64, true)!;
  const doc = await env.DB.prepare("SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL").bind(documentId).first();
  if (!doc) throw new DocumentError("Document not found", 404);
  const id = ulid(now.getTime());
  const stamp = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO highlights (id, document_id, text, prefix, suffix, note, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, documentId, text(input.text, "text", 5_000, true), text(input.prefix, "prefix", 200), text(input.suffix, "suffix", 200),
    text(input.note, "note", 5_000), text(input.color, "color", 20), stamp, stamp).run();
  return getHighlight(env, id);
}

export async function updateHighlight(env: Env, id: string, input: Record<string, unknown>, now = new Date()): Promise<HighlightRow> {
  const current = await getHighlight(env, id);
  const note = "note" in input ? text(input.note, "note", 5_000) : current.note;
  const color = "color" in input ? text(input.color, "color", 20) : current.color;
  await env.DB.prepare("UPDATE highlights SET note = ?, color = ?, updated_at = ? WHERE id = ?")
    .bind(note, color, now.toISOString(), id).run();
  return getHighlight(env, id);
}

export async function deleteHighlight(env: Env, id: string, now = new Date()) {
  const result = await env.DB.prepare("UPDATE highlights SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(now.toISOString(), now.toISOString(), id).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new DocumentError("Highlight not found", 404);
}
