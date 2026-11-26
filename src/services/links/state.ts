import type { Env } from "../../types/env";
import { DocumentError } from "../documents";
import { getLink, type LinkRow } from "./store";
import { isDay } from "../../utils/date";

// Your reading state on a link: where you are, read or not, stars, tags, title, note.

export interface ProgressInput {
  progress: number; anchor?: string | null; updated_at?: string; device?: string | null; day?: string | null;
  /** Active reading seconds since this device's last report, measured by the app. */
  seconds?: number | null;
  /** Words in the text the app rendered; raises reading_minutes when it says more. */
  words?: number | null;
  /** The app's id for this report (a UUID), so a retried request counts its seconds once. */
  report_id?: string | null;
}

/** Words per minute behind reading_minutes (the same rate a fetch uses). */
const WORDS_PER_MINUTE = 230;
/** Slack on the wall-clock window, for a report that lands just after the time it covers. */
const SLACK_SECONDS = 30;
/** No single report adds more than this, whatever the clocks say. */
const MAX_REPORT_SECONDS = 600;

/**
 * The seconds a report may add: what the app measured, at most the wall-clock
 * time since the link's previous progress (server time, plus slack), and never
 * more than ten minutes. A link with no previous progress gets the cap.
 */
export function creditedSeconds(seconds: number, previousAt: string | null, now: Date): number {
  const previous = previousAt ? Date.parse(previousAt) : NaN;
  const window = Number.isNaN(previous) ? MAX_REPORT_SECONDS : Math.max(0, (now.getTime() - previous) / 1000) + SLACK_SECONDS;
  return Math.max(0, Math.min(seconds, window, MAX_REPORT_SECONDS));
}

/**
 * Where you are in an article. Last write wins by the time the reading
 * happened (sent by the device), so a phone that was offline can't pull the
 * Mac back to an older spot when it reconnects. A time from the future (a
 * wrong clock) counts as now. `applied` says whether this write won.
 *
 * Time read (reading_days): with `seconds`, the clamped seconds the app
 * measured, whether or not the position moved or won (re-reading counts);
 * docs/adr/0006-reading-time-from-seconds.md. Without it (older apps), how far
 * you moved forward times the article's minutes.
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
  const minutesLong = await raiseReadingMinutes(env, id, before.reading_minutes, input.words);
  // The day you read it: the phone's own date when it sends one.
  const day = isDay(input.day) ? input.day : at.slice(0, 10);
  try {
    if (typeof input.seconds === "number") {
      const seconds = creditedSeconds(input.seconds, before.progress_updated_at ?? null, now);
      if (seconds > 0 && (await firstReport(env, id, input.report_id, day, seconds, now))) await addMinutes(env, day, id, seconds / 60);
    } else {
      // How far you moved forward, in the article's minutes. Going back up adds nothing.
      const gained = progress - (before.progress ?? 0);
      if (applied && gained > 0.002) await addMinutes(env, day, id, Math.min(gained, 1) * Math.max(minutesLong ?? 1, 1));
    }
  } catch { /* stats are a bonus; the position itself is saved */ }
  return { applied, ...readingOf(await getLink(env, id)) };
}

async function addMinutes(env: Env, day: string, id: string, minutes: number) {
  await env.DB.prepare(
    `INSERT INTO reading_days (day, document_id, minutes) VALUES (?, ?, ?)
     ON CONFLICT (day, document_id) DO UPDATE SET minutes = reading_days.minutes + excluded.minutes`,
  ).bind(day, id, minutes).run();
}

/**
 * Whether this report is new: records `report_id` for the link and says false
 * when it was already there (a retry). A report without an id can't be told
 * apart from a retry, so it always counts; so does every report while the
 * table (migration 0051) isn't there yet.
 */
async function firstReport(env: Env, id: string, reportId: string | null | undefined, day: string, seconds: number, now: Date): Promise<boolean> {
  if (!reportId) return true;
  try {
    const recorded = await env.DB.prepare(
      "INSERT OR IGNORE INTO reading_reports (document_id, report_id, day, seconds, received_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, reportId, day, seconds, now.toISOString()).run();
    return (recorded.meta?.changes ?? 0) === 1;
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return true;
    throw error;
  }
}

/**
 * The app counted the words it rendered: when they make the article longer
 * than reading_minutes says (a fetch that missed most of the page), raise it.
 * Never lowers it. Returns the minutes now on the link.
 */
async function raiseReadingMinutes(env: Env, id: string, current: number | null, words: number | null | undefined): Promise<number | null> {
  if (typeof words !== "number" || words <= 0) return current;
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  if (current != null && minutes <= current) return current;
  await env.DB.prepare("UPDATE links SET reading_minutes = ? WHERE document_id = ? AND (reading_minutes IS NULL OR reading_minutes < ?)")
    .bind(minutes, id, minutes).run();
  return minutes;
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
