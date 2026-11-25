import type { Env } from "../../types/env";

// Reading over time, from reading_days (minutes per article per day).

/**
 * Reading over time: minutes and articles per day, finished per month, favourite
 * sites. Articles finished before time was tracked count their reading time on
 * the day you finished them, so the history starts full.
 */
export async function readingStats(env: Env, since: string, day?: string) {
  const tracked = await env.DB.prepare(
    `SELECT day, SUM(minutes) AS minutes, COUNT(*) AS articles FROM reading_days WHERE day >= ? GROUP BY day`,
  ).bind(since).all<{ day: string; minutes: number; articles: number }>();
  const earlier = await env.DB.prepare(
    `SELECT substr(l.read_at, 1, 10) AS day, SUM(COALESCE(l.reading_minutes, 1)) AS minutes, COUNT(*) AS articles
     FROM links l JOIN documents d ON d.id = l.document_id
     WHERE d.deleted_at IS NULL AND l.read_at IS NOT NULL AND substr(l.read_at, 1, 10) >= ?
       AND NOT EXISTS (SELECT 1 FROM reading_days r WHERE r.document_id = l.document_id)
     GROUP BY day`,
  ).bind(since).all<{ day: string; minutes: number; articles: number }>();
  const byDay = new Map<string, { day: string; minutes: number; articles: number }>();
  for (const r of [...(tracked.results ?? []), ...(earlier.results ?? [])]) {
    const d = byDay.get(r.day) ?? { day: r.day, minutes: 0, articles: 0 };
    d.minutes += r.minutes; d.articles += r.articles;
    byDay.set(r.day, d);
  }
  const finished = await env.DB.prepare(
    `SELECT substr(l.read_at, 1, 7) AS month, COUNT(*) AS count FROM links l JOIN documents d ON d.id = l.document_id
     WHERE d.deleted_at IS NULL AND l.read_at IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 24`,
  ).all<{ month: string; count: number }>();
  const sites = await env.DB.prepare(
    `SELECT l.site AS site, COUNT(*) AS count FROM links l JOIN documents d ON d.id = l.document_id
     LEFT JOIN link_reading r ON r.document_id = l.document_id
     WHERE d.deleted_at IS NULL AND l.site IS NOT NULL AND (l.read_at IS NOT NULL OR COALESCE(r.progress, 0) > 0.1)
     GROUP BY l.site ORDER BY count DESC LIMIT 5`,
  ).all<{ site: string; count: number }>();
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS saved, SUM(CASE WHEN l.read_at IS NOT NULL THEN 1 ELSE 0 END) AS finished,
       SUM(CASE WHEN l.read_at IS NULL AND COALESCE(r.progress, 0) > 0.02 THEN 1 ELSE 0 END) AS reading
     FROM links l JOIN documents d ON d.id = l.document_id LEFT JOIN link_reading r ON r.document_id = l.document_id
     WHERE d.deleted_at IS NULL`,
  ).first<{ saved: number; finished: number; reading: number }>();
  const highlights = await env.DB.prepare(`SELECT COUNT(*) AS n FROM highlights`).first<{ n: number }>();
  const articles = day ? await readingOnDay(env, day) : undefined;
  return {
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, minutes: Math.round(d.minutes * 10) / 10 })),
    finished_by_month: finished.results ?? [],
    top_sites: sites.results ?? [],
    totals: { saved: totals?.saved ?? 0, finished: totals?.finished ?? 0, reading: totals?.reading ?? 0, highlights: highlights?.n ?? 0 },
    ...(articles ? { day, articles } : {}),
  };
}

/**
 * What you read on one day, article by article, from `reading_days`: the
 * minutes each one added that day, in the order you last read them (the one
 * you're on now comes last). Deleted articles are left out; an article whose
 * document row is gone still counts, untitled.
 */
export async function readingOnDay(env: Env, day: string) {
  const rows = await env.DB.prepare(
    `SELECT r.document_id AS id, d.title AS title, r.minutes AS minutes
     FROM reading_days r
     LEFT JOIN documents d ON d.id = r.document_id
     LEFT JOIN link_reading lr ON lr.document_id = r.document_id
     WHERE r.day = ? AND d.deleted_at IS NULL
     ORDER BY COALESCE(lr.progress_updated_at, '') ASC, r.document_id ASC`,
  ).bind(day).all<{ id: string; title: string | null; minutes: number }>();
  return (rows.results ?? []).map((r) => ({ id: r.id, title: r.title ?? null, minutes: Math.round(r.minutes * 10) / 10 }));
}
