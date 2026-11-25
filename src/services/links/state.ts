import type { Env } from "../../types/env";
import { DocumentError } from "../documents";
import { getLink, type LinkRow } from "./store";

// Your reading state on a link: where you are, read or not, stars, tags, title, note.

export interface ProgressInput { progress: number; anchor?: string | null; updated_at?: string; device?: string | null; day?: string | null }

/**
 * Where you are in an article. Last write wins by the time the reading
 * happened (sent by the device), so a phone that was offline can't pull the
 * Mac back to an older spot when it reconnects. A time from the future (a
 * wrong clock) counts as now. `applied` says whether this write won.
 */
export async function saveProgress(env: Env, id: string, input: ProgressInput, now = new Date()) {
  const before = await getLink(env, id);
  const sent = input.updated_at ? new Date(input.updated_at) : now;
  const at = (Number.isNaN(sent.getTime()) || sent.getTime() > now.getTime() + 60_000 ? now : sent).toISOString();
  const progress = Math.min(1, Math.max(0, input.progress));
  const result = await env.DB.prepare(
    `INSERT INTO link_reading (document_id, progress, progress_anchor, progress_updated_at, progress_device, opened_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (document_id) DO UPDATE SET
       progress = excluded.progress, progress_anchor = excluded.progress_anchor,
       progress_updated_at = excluded.progress_updated_at, progress_device = excluded.progress_device,
       opened_at = COALESCE(link_reading.opened_at, excluded.opened_at)
     WHERE link_reading.progress_updated_at IS NULL OR link_reading.progress_updated_at < excluded.progress_updated_at`,
  ).bind(id, progress, input.anchor ?? null, at, input.device ?? null, at).run();
  const applied = (result.meta?.changes ?? 0) === 1;
  // Time read: how far you moved forward, in the article's minutes, on the day you read it
  // (the phone's own date when it sends one). Going back up adds nothing.
  const gained = progress - (before.progress ?? 0);
  if (applied && gained > 0.002) {
    const day = typeof input.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : at.slice(0, 10);
    const minutes = Math.min(gained, 1) * Math.max(before.reading_minutes ?? 1, 1);
    try {
      await env.DB.prepare(
        `INSERT INTO reading_days (day, document_id, minutes) VALUES (?, ?, ?)
         ON CONFLICT (day, document_id) DO UPDATE SET minutes = reading_days.minutes + excluded.minutes`,
      ).bind(day, id, minutes).run();
    } catch { /* stats are a bonus; the position itself is saved */ }
  }
  return { applied, ...readingOf(await getLink(env, id)) };
}

export function readingOf(row: LinkRow) {
  return {
    progress: row.progress ?? 0, progress_anchor: row.progress_anchor ?? null,
    progress_updated_at: row.progress_updated_at ?? null, progress_device: row.progress_device ?? null,
    opened_at: row.opened_at ?? null,
  };
}

/** Your note on the whole article; null or "" clears it. */
export async function setLinkNote(env: Env, id: string, note: string | null, now = new Date()) {
  const text = note?.trim() ? note.trim() : null;
  const stamp = now.toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO link_reading (document_id, note, note_updated_at) VALUES (?, ?, ?)
       ON CONFLICT (document_id) DO UPDATE SET note = excluded.note, note_updated_at = excluded.note_updated_at`,
    ).bind(id, text, stamp),
    env.DB.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").bind(stamp, id),
  ]);
}

export async function markRead(env: Env, id: string, read: boolean, now = new Date()): Promise<LinkRow> {
  await getLink(env, id);
  const stamp = now.toISOString();
  await env.DB.batch([
    // Archiving twice keeps the first time you finished it.
    env.DB.prepare("UPDATE links SET read_at = CASE WHEN ? THEN COALESCE(read_at, ?) ELSE NULL END WHERE document_id = ?").bind(read ? 1 : 0, stamp, id),
    // Bump updated_at so the apps' incremental sync sees the change.
    env.DB.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").bind(stamp, id),
  ]);
  return getLink(env, id);
}

/**
 * Star, tag or retitle a saved link. Stars and tags live in the link's
 * document frontmatter, so no schema change is needed.
 */
export async function updateLink(env: Env, id: string, input: { starred?: unknown; tags?: unknown; title?: unknown }, now = new Date()): Promise<LinkRow> {
  const link = await getLink(env, id);
  const fm: Record<string, unknown> = link.frontmatter_json ? JSON.parse(link.frontmatter_json) : {};
  if (typeof input.starred === "boolean") {
    if (input.starred) fm.starred_at = fm.starred_at ?? now.toISOString();
    else delete fm.starred_at;
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== "string") || input.tags.length > 30) {
      throw new DocumentError("tags must be a list of up to 30 words", 400);
    }
    fm.tags = [...new Set((input.tags as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
  }
  let title = link.title;
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 300) throw new DocumentError("title must be 1 to 300 characters", 400);
    title = input.title.trim();
  }
  await env.DB.prepare("UPDATE documents SET title = ?, frontmatter_json = ?, updated_at = ?, version = version + 1 WHERE id = ?")
    .bind(title, JSON.stringify(fm), now.toISOString(), id).run();
  return getLink(env, id);
}
