import type { Env } from "../types/env";

// Writing's folders ("sections") as a tree. A folder is its path, the same
// string a page keeps in documents.folder ("Library/Agent Skills"), so pages
// need no new column and the site's posts are never touched. The sections
// table remembers folders that have no pages yet, and their order.
// Only notes live in folders: drafts and published writing keep their own
// places ("Writing", "Writing/Drafts") and are never moved by folder changes.

export class SectionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409, readonly code: string) {
    super(message);
  }
}

export interface SectionRow {
  path: string;
  parent: string;
  name: string;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Section {
  path: string;
  name: string;
  parent: string;
  depth: number;
  /** Notes directly in this folder. */
  count: number;
  /** Notes in this folder and every folder inside it. */
  total: number;
  sort_order: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export const MAX_PATH = 200;

/** "Library//Agent Skills/" → "Library/Agent Skills". */
export function normalizePath(path: string): string {
  return path.split("/").map((part) => part.trim()).filter(Boolean).join("/");
}

export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
const isInside = (path: string, folder: string) => path === folder || path.startsWith(folder + "/");

/** Every folder a path implies: "a/b/c" → a, a/b, a/b/c. */
export function prefixes(path: string): string[] {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Moves a path that sits inside `from` so it sits inside `to` instead. */
export function rebase(path: string, from: string, to: string): string {
  if (path === from) return to;
  return join(to, path.slice(from.length + 1));
}

const likePrefix = (folder: string) => folder.replace(/[\\%_]/g, (c) => "\\" + c) + "/%";

async function noteFolders(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT folder, COUNT(*) AS n FROM documents WHERE deleted_at IS NULL AND kind = 'note' GROUP BY folder",
  ).all<{ folder: string; n: number }>();
  return results;
}

async function rows(env: Env): Promise<SectionRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM sections").all<SectionRow>();
  return results;
}

/** Keeps a folder (and the folders above it) on record. Revives one that was deleted. */
function upsert(env: Env, path: string, stamp: string, sortOrder: number | null = null) {
  return env.DB.prepare(
    `INSERT INTO sections (path, parent, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at,
       sort_order = COALESCE(excluded.sort_order, sections.sort_order)
     WHERE sections.deleted_at IS NOT NULL OR excluded.sort_order IS NOT NULL`,
  ).bind(path, parentOf(path), nameOf(path), sortOrder, stamp, stamp);
}

/** The tree, depth first: siblings in their saved order, then by name. */
export async function listSections(env: Env, now = new Date()): Promise<{ items: Section[]; unsorted: number }> {
  const [folders, saved] = await Promise.all([noteFolders(env), rows(env)]);
  const live = new Map(saved.filter((r) => !r.deleted_at).map((r) => [r.path, r]));
  const direct = new Map<string, number>();
  let unsorted = 0;
  const implied = new Set<string>();
  for (const { folder, n } of folders) {
    const path = normalizePath(folder);
    if (!path) { unsorted += Number(n); continue; }
    direct.set(path, (direct.get(path) ?? 0) + Number(n));
    for (const p of prefixes(path)) implied.add(p);
  }
  for (const r of live.values()) for (const p of prefixes(r.path)) implied.add(p);

  // Folders pages already use go on record, so they stay when their last page leaves.
  const stamp = now.toISOString();
  const missing = [...implied].filter((p) => !live.has(p));
  if (missing.length) {
    await env.DB.batch(missing.map((p) => upsert(env, p, stamp)));
    for (const p of missing) live.set(p, { path: p, parent: parentOf(p), name: nameOf(p), sort_order: null, created_at: stamp, updated_at: stamp, deleted_at: null });
  }

  const children = new Map<string, SectionRow[]>();
  for (const r of live.values()) {
    const list = children.get(r.parent) ?? [];
    list.push(r);
    children.set(r.parent, list);
  }
  const order = (a: SectionRow, b: SectionRow) =>
    (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER)
    || a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true });

  const items: Section[] = [];
  const walk = (parent: string, depth: number): number => {
    let sum = 0;
    for (const r of (children.get(parent) ?? []).sort(order)) {
      const item: Section = {
        path: r.path, name: r.name, parent: r.parent, depth,
        count: direct.get(r.path) ?? 0, total: 0,
        sort_order: r.sort_order, created_at: r.created_at, updated_at: r.updated_at,
      };
      items.push(item);
      item.total = item.count + walk(r.path, depth + 1);
      sum += item.total;
    }
    return sum;
  };
  walk("", 0);
  return { items, unsorted };
}

async function find(env: Env, path: string): Promise<Section | undefined> {
  return (await listSections(env)).items.find((s) => s.path === path);
}

async function exists(env: Env, path: string): Promise<boolean> {
  if (!path) return true;
  return (await find(env, path)) !== undefined;
}

function check(path: string) {
  if (path.length > MAX_PATH) throw new SectionError(`A folder path can be up to ${MAX_PATH} characters`, 400, "invalid");
}

export async function createSection(env: Env, input: { name: string; parent?: string; sort_order?: number | null }, now = new Date()) {
  const parent = normalizePath(input.parent ?? "");
  const path = join(parent, input.name);
  check(path);
  if (!(await exists(env, parent))) throw new SectionError("That parent folder doesn't exist", 404, "not_found");
  if (await exists(env, path)) throw new SectionError(`“${input.name}” already exists here`, 409, "exists");
  const stamp = now.toISOString();
  await env.DB.batch([...prefixes(path).map((p) => upsert(env, p, stamp, p === path ? input.sort_order ?? null : null))]);
  return (await find(env, path))!;
}

/** A folder and everything inside it, the folder itself first (outermost to innermost). */
function subtree(all: SectionRow[], folder: string): SectionRow[] {
  return all.filter((r) => !r.deleted_at && isInside(r.path, folder)).sort((a, b) => a.path.length - b.path.length);
}

/** Every note in a folder or below it, with where it should go next. */
async function notesInside(env: Env, folder: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, folder FROM documents WHERE deleted_at IS NULL AND kind = 'note' AND (folder = ? OR folder LIKE ? ESCAPE '\\')",
  ).bind(folder, likePrefix(folder)).all<{ id: string; folder: string }>();
  return results;
}

/**
 * Renames a folder, moves it under another, or reorders it. Everything inside
 * comes along: its notes and its folders. Notes get a new version, so a
 * device holding the old one reloads instead of moving it back.
 */
export async function updateSection(env: Env, input: { path: string; name?: string; parent?: string; sort_order?: number | null }, now = new Date()) {
  const from = normalizePath(input.path);
  const current = from ? await find(env, from) : undefined;
  if (!current) throw new SectionError("Folder not found", 404, "not_found");
  const parent = input.parent === undefined ? current.parent : normalizePath(input.parent);
  const to = join(parent, input.name ?? current.name);
  check(to);
  if (isInside(parent, from)) throw new SectionError("A folder can't go inside itself", 400, "invalid");
  if (!(await exists(env, parent))) throw new SectionError("That parent folder doesn't exist", 404, "not_found");
  const stamp = now.toISOString();

  if (to === from) {
    if (input.sort_order !== undefined) {
      await env.DB.prepare("UPDATE sections SET sort_order = ?, updated_at = ? WHERE path = ?").bind(input.sort_order, stamp, from).run();
    }
    return { section: (await find(env, from))!, moved_pages: 0, moved_folders: 0 };
  }
  // Two folders with one name would quietly merge; ask for another name instead.
  // (Only a different spelling of the same name, "notes" → "Notes", is the same folder.)
  if (to.toLowerCase() !== from.toLowerCase() && (await exists(env, to))) {
    throw new SectionError(`“${nameOf(to)}” already exists there`, 409, "exists");
  }
  const result = await moveTree(env, from, to, stamp, input.sort_order);
  return { section: (await find(env, to))!, ...result };
}

/** Moves a folder's subtree from one path to another: its rows, then its notes. */
async function moveTree(env: Env, from: string, to: string, stamp: string, sortOrder?: number | null) {
  const saved = subtree(await rows(env), from);
  const notes = await notesInside(env, from);
  const statements: D1PreparedStatement[] = [];
  // The parents of the new place first, so the tree never has a gap.
  for (const p of prefixes(parentOf(to))) statements.push(upsert(env, p, stamp));
  for (const r of saved) {
    statements.push(env.DB.prepare("UPDATE sections SET deleted_at = ?, updated_at = ? WHERE path = ?").bind(stamp, stamp, r.path));
    statements.push(upsert(env, rebase(r.path, from, to), stamp, r.path === from ? sortOrder ?? r.sort_order : r.sort_order));
  }
  for (const note of notes) {
    const next = rebase(normalizePath(note.folder), from, to);
    statements.push(env.DB.prepare(
      "UPDATE documents SET folder = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL",
    ).bind(next, stamp, note.id));
  }
  if (statements.length) await env.DB.batch(statements);
  return { moved_pages: notes.length, moved_folders: saved.length };
}

/**
 * Deletes a folder and never its pages: its notes and the folders inside it
 * move up one level, into its parent (or to the top). A folder already there
 * with the same name takes them in.
 */
export async function deleteSection(env: Env, path: string, now = new Date()) {
  const from = normalizePath(path);
  const current = from ? await find(env, from) : undefined;
  if (!current) throw new SectionError("Folder not found", 404, "not_found");
  const parent = current.parent;
  const stamp = now.toISOString();
  const saved = subtree(await rows(env), from);
  const notes = await notesInside(env, from);
  const statements: D1PreparedStatement[] = [];
  for (const r of saved) {
    statements.push(env.DB.prepare("UPDATE sections SET deleted_at = ?, updated_at = ? WHERE path = ?").bind(stamp, stamp, r.path));
    if (r.path !== from) statements.push(upsert(env, rebase(r.path, from, parent), stamp, r.sort_order));
  }
  for (const note of notes) {
    statements.push(env.DB.prepare(
      "UPDATE documents SET folder = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL",
    ).bind(rebase(normalizePath(note.folder), from, parent), stamp, note.id));
  }
  if (statements.length) await env.DB.batch(statements);
  return { ok: true as const, parent, moved_pages: notes.length, moved_folders: Math.max(0, saved.length - 1) };
}
