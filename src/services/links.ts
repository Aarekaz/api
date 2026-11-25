import type { Env } from "../types/env";
import { createDocument, DocumentError, type DocumentRow } from "./documents";

// Read later. A saved link is a `link` document (so it syncs, searches and
// backs up like everything else) plus a `links` row with the URL and reading
// state. The article's readable text is fetched once and stored as the
// document's Markdown body, so it reads offline and full-text search covers it.

export interface Article {
  title: string | null;
  site: string | null;
  excerpt: string | null;
  markdown: string;
  words: number;
  /** Lead image (og:image), absolute. */
  image: string | null;
  /** The site's icon, absolute. */
  icon: string | null;
}

function absolute(src: string | undefined, base: string): string | null {
  if (!src || src.startsWith("data:")) return null;
  try {
    const url = new URL(decodeEntities(src.trim()), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3]) : undefined;
}

/** Profile pictures and tiny thumbnails: X's avatars, Substack's 40-pixel crops, "X avatar for @…". */
export function isAvatar(src: string, alt = ""): boolean {
  return /\/profile_images\/|[,!\/]w_\d{1,2},h_\d{1,2}[,\/]|\/avatars?\//i.test(src) || /^(x |twitter )?avatar\b|^avatar for /i.test(alt);
}

/** An image as Markdown, or "" for tracking pixels, avatars and inline data. */
function imageMarkdown(tag: string, base: string): string {
  const src = absolute(attr(tag, "src") ?? attr(tag, "data-src") ?? attr(tag, "srcset")?.split(/[\s,]/)[0], base);
  if (!src) return "";
  const width = Number(attr(tag, "width") ?? "0"), height = Number(attr(tag, "height") ?? "0");
  if ((width > 0 && width < 40) || (height > 0 && height < 40)) return "";
  const alt = decodeEntities(attr(tag, "alt") ?? "").replace(/[\[\]]/g, "").trim();
  if (isAvatar(src, alt)) return "";
  return `![${alt}](${src})`;
}

/**
 * A newsletter's furniture, not the writer's words: "Subscribe now", "Thanks for
 * reading X! Subscribe for free…", "Become a paid subscriber…", share buttons,
 * WordPress's "Copy shortlink · Manage subscriptions". Only short lines.
 */
export function isBoilerplate(line: string): boolean {
  const text = line.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^(## |- |> )/, "").replace(/[*_]/g, "").trim();
  if (text.length > 200) return false;
  return /\b(subscribe|subscribed|paid subscriber)\b/i.test(text)
    || /^thanks for reading\b/i.test(text)
    || /^get \d+% off\b/i.test(text)
    || /copy shortlink|manage subscriptions|view post in reader|report this content/i.test(text)
    || /^(share|like|comment|restack|sign up|sign in|log in|discussion about this post)$/i.test(text);
}

/** Stored Markdown with avatars and newsletter furniture taken out (for text saved before the rules existed). */
export function cleanMarkdown(markdown: string): string {
  return markdown.split("\n\n").filter((block) => {
    const image = block.trim().match(/^!\[([^\]]*)\]\((\S+)\)$/);
    if (image) return !isAvatar(image[2], image[1]);
    return !isBoilerplate(block.trim());
  }).join("\n\n");
}

/** A data table as Markdown ("| a | b |"), or null for a layout table (one column, nested, or long cells). */
export function tableMarkdown(html: string, base: string): string | null {
  if (/<table\b/i.test(html)) return null;
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
    [...r[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => inline(c[2], base).replace(/\|/g, "\\|")));
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (rows.length < 2 || width < 2 || rows.some((r) => r.some((c) => c.length > 600))) return null;
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", middot: "·", copy: "©",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function plain(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Text with its emphasis and links kept as Markdown: **bold**, *italic*, [text](url). */
function inline(html: string, base: string): string {
  const marked = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => {
      const text = plain(inner);
      return text ? ` **${text}** ` : "";
    })
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => {
      const text = plain(inner);
      return text ? ` *${text}* ` : "";
    })
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
      const text = plain(inner);
      const href = absolute(attr(`<a ${attrs}>`, "href"), base);
      return text && href ? ` [${text.replace(/[\[\]]/g, "")}](${href}) ` : text;
    });
  return plain(marked)
    .replace(/\s+([.,;:!?)])/g, "$1")      // no space before punctuation left by the markers
    .replace(/([(“"])\s+/g, "$1")
    .replace(/\*\*\s*\*\*/g, "");
}

function metaTags(html: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? "";
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (key && attrs.content && !meta.has(key)) meta.set(key, decodeEntities(attrs.content).trim());
  }
  return meta;
}

/** The readable part of a page as Markdown: headings, paragraphs, lists, quotes, code. */
/**
 * Pages without an <article> tag bring their shop, menus and newsletter boxes along.
 * The story runs from the first real paragraph to the last one, so cut what's outside
 * (keeping a heading or image that leads straight into it).
 */
export function trimToArticle(lines: string[]) {
  const isProse = (l: string) => !/^(## |- |> |!\[|```|\| )/.test(l)
    && l.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").length >= 100;
  const first = lines.findIndex(isProse);
  if (first < 0) return;
  let last = lines.length - 1;
  while (last > first && !isProse(lines[last]) && !/^(- |> |```|!\[|\| )/.test(lines[last])) last--;
  let start = first;
  while (start > 0 && start > first - 2 && /^(## |!\[)/.test(lines[start - 1])) start--;
  lines.splice(last + 1);
  lines.splice(0, start);
}

export function extractArticle(html: string, url: string): Article {
  const meta = metaTags(html);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = meta.get("og:title") || meta.get("twitter:title") || (titleTag ? plain(titleTag) : "") || null;
  let host: string | null = null;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep null */ }
  const site = meta.get("og:site_name") || host;

  let content = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "iframe", "button", "figcaption"]) {
    content = content.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }
  const articles = [...content.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]);
  const scope = articles.sort((a, b) => b.length - a.length)[0]
    ?? content.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? content.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1]
    ?? content;

  // Data tables become Markdown tables, held aside so the paragraph pass leaves them whole.
  const tables: string[] = [];
  const withTables = scope.replace(/<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/gi, (whole, inner: string) => {
    const md = tableMarkdown(inner, url);
    if (!md) return whole;
    tables.push(md);
    return `<mdtable>${tables.length - 1}</mdtable>`;
  });
  // Images become their own paragraphs, so the reader can show them in place.
  const withImages = withTables.replace(/<img\b[^>]*>/gi, (tag) => {
    const md = imageMarkdown(tag, url);
    return md ? `<p>${md}</p>` : "";
  });

  const lines: string[] = [];
  for (const m of withImages.matchAll(/<(h[1-6]|p|li|blockquote|pre|mdtable)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    if (tag === "mdtable") { lines.push(tables[Number(m[2])]); continue; }
    if (tag === "pre") {
      const code = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trimEnd();
      if (code.trim()) lines.push("```\n" + code + "\n```");
      continue;
    }
    // An image wrapped in a paragraph that already holds text splits into both.
    const inner = m[2].replace(/<p>(!\[[^\]]*\]\([^)]+\))<\/p>/g, "\n$1\n");
    if (inner.includes("![")) {
      for (const part of inner.split("\n")) {
        const image = part.match(/^!\[[^\]]*\]\([^)]+\)$/);
        if (image) { lines.push(image[0]); continue; }
        const piece = inline(part, url);
        if (piece.length >= 2) lines.push(tag[0] === "h" ? `## ${piece}` : tag === "li" ? `- ${piece}` : tag === "blockquote" ? `> ${piece}` : piece);
      }
      continue;
    }
    // Code keeps its words as they are; everything else keeps bold, italics and links.
    const text = inline(m[2], url);
    if (text.length < 2) continue;
    if (tag[0] === "h") lines.push(`## ${text}`);
    else if (tag === "li") lines.push(`- ${text}`);
    else if (tag === "blockquote") lines.push(`> ${text}`);
    else lines.push(text);
  }
  for (let i = lines.length - 1; i >= 0; i--) if (isBoilerplate(lines[i])) lines.splice(i, 1);
  trimToArticle(lines);
  // Drop a leading heading that only repeats the title.
  if (title && lines[0]?.replace(/^## /, "").replace(/\*/g, "") === title) lines.shift();
  const markdown = lines.join("\n\n").slice(0, 200_000);
  const words = markdown.replace(/!\[[^\]]*\]\([^)]+\)/g, "").split(/\s+/).filter(Boolean).length;
  const image = absolute(meta.get("og:image") || meta.get("twitter:image"), url);
  const iconTag = (html.match(/<link\b[^>]*rel\s*=\s*["'][^"']*(apple-touch-icon|icon)[^"']*["'][^>]*>/gi) ?? [])
    .sort((a, b) => Number(/apple-touch-icon/i.test(b)) - Number(/apple-touch-icon/i.test(a)))[0];
  let icon = iconTag ? absolute(attr(iconTag, "href"), url) : null;
  if (!icon) { try { icon = new URL("/favicon.ico", url).toString(); } catch { icon = null; } }
  const excerpt = meta.get("og:description") || meta.get("description") || lines.find((l) => !l.startsWith("#") && !l.startsWith("![") && l.length > 60)?.replace(/\*\*?|\[|\]\([^)]*\)/g, "").slice(0, 280) || null;
  return { title, site, excerpt, markdown, words, image, icon };
}

/** http(s) only, without tracking parameters or a fragment. */
export function normalizeUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new DocumentError("That isn't a valid URL", 400); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DocumentError("Only http and https links can be saved", 400);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_|ref_src$|igshid$|si$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export function isSingleUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

export interface LinkRow extends DocumentRow {
  url: string; site: string | null; excerpt: string | null; reading_minutes: number | null;
  read_at: string | null; fetched_at: string | null; fetch_error: string | null;
  // From link_reading (null until the link is first opened or noted).
  progress: number | null; progress_anchor: string | null; progress_updated_at: string | null;
  progress_device: string | null; opened_at: string | null; note: string | null; note_updated_at: string | null;
}

export type LinkKind = "article" | "video" | "pdf" | "post";

/** What kind of page a link is, so the apps can open it the right way. */
export function linkKind(url: string, fetchError: string | null = null): LinkKind {
  let host = "", path = "";
  try { const u = new URL(url); host = u.hostname.replace(/^(www|m|mobile)\./, "").toLowerCase(); path = u.pathname.toLowerCase(); } catch { /* article */ }
  if (/^(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|twitch\.tv|loom\.com)$/.test(host)) return "video";
  if (path.endsWith(".pdf") || /application\/pdf/i.test(fetchError ?? "")) return "pdf";
  if (/^(x\.com|twitter\.com|threads\.net|bsky\.app|instagram\.com)$/.test(host)) return "post";
  return "article";
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

export async function getLink(env: Env, id: string): Promise<LinkRow> {
  const row = await env.DB.prepare(`${SELECT} WHERE d.id = ? AND d.deleted_at IS NULL`).bind(id).first<LinkRow>();
  if (!row) throw new DocumentError("Link not found", 404);
  return row;
}

export type LinkListState = "unread" | "read" | "starred" | "all" | "inbox" | "archived";

/** Saved links, newest first. `inbox` is `unread` and `archived` is `read` under their plan names. */
export async function listLinks(env: Env, state: LinkListState = "all", limit = 500, tag?: string): Promise<LinkRow[]> {
  const filter = state === "unread" || state === "inbox" ? " AND l.read_at IS NULL"
    : state === "read" || state === "archived" ? " AND l.read_at IS NOT NULL"
    : state === "starred" ? " AND json_extract(d.frontmatter_json, '$.starred_at') IS NOT NULL" : "";
  const tagFilter = tag ? " AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(d.frontmatter_json, '$.tags'), '[]')) t WHERE t.value = ?)" : "";
  const binds: unknown[] = tag ? [tag.trim().toLowerCase()] : [];
  const { results } = await env.DB.prepare(
    `${SELECT} WHERE d.deleted_at IS NULL${filter}${tagFilter} ORDER BY d.created_at DESC LIMIT ?`,
  ).bind(...binds, Math.min(Math.max(limit, 1), 2000)).all<LinkRow>();
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

/**
 * Reading over time: minutes and articles per day, finished per month, favourite
 * sites. Articles finished before time was tracked count their reading time on
 * the day you finished them, so the history starts full.
 */
export async function readingStats(env: Env, since: string) {
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
  return {
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, minutes: Math.round(d.minutes * 10) / 10 })),
    finished_by_month: finished.results ?? [],
    top_sites: sites.results ?? [],
    totals: { saved: totals?.saved ?? 0, finished: totals?.finished ?? 0, reading: totals?.reading ?? 0, highlights: highlights?.n ?? 0 },
  };
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

/** Fetches the page and stores its readable text. Failures are recorded, not thrown. */
/**
 * Titles sites give their pages for sharing, cleaned for a reading list:
 * `Dhravya Shah on X: "Jev changes a lot" / X` becomes the quoted words.
 */
/** The page's own address for itself (<link rel="canonical"> or og:url). */
export function canonicalUrl(html: string, base: string): string | null {
  const tag = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i)?.[0];
  return absolute(tag ? attr(tag, "href") : metaTags(html).get("og:url"), base);
}

export function cleanTitle(title: string): string {
  const x = title.match(/^(.+?) on (?:X|Twitter): ["“](.+)["”]\s*\/\s*(?:X|Twitter)$/s);
  if (x) return x[2].trim();
  return title.trim();
}

/** The words of a post as X's own embed gives them: paragraphs, no media links. */
export function postText(oembedHtml: string): string {
  const p = oembedHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
  return decodeEntities(p
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a[^>]*>(?:pic\.twitter\.com|https?:\/\/t\.co)[^<]*<\/a>/gi, "")
    .replace(/<a[^>]*>([^<]*)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A short title from a post's first line, cut at a word. */
export function titleFromText(text: string, max = 90): string {
  const first = (text.split("\n").map((l) => l.replace(/https?:\/\/\S+/g, "").trim()).find((l) => l.length > 0) ?? "");
  if (first.length <= max) return first.replace(/[:：]\s*$/, "");
  const cut = first.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,;:—-]\s*$/, "") + "…";
}

/** "Some-Paper_v2.pdf" → "Some Paper v2". */
export function titleFromPdfUrl(url: string): string | null {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    const base = name.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();
    return base.length >= 3 && !/^\d+(\.\d+)?(v\d+)?$/.test(base) ? base : null;
  } catch { return null; }
}

/** A post as FixTweet's public API gives it: the whole text (long posts too), real photos, the quoted post. */
interface FxPost {
  text?: string;
  author?: { name?: string; screen_name?: string };
  media?: { photos?: Array<{ url: string }>; videos?: Array<{ url?: string; thumbnail_url?: string }> };
  quote?: FxPost | null;
  article?: { title?: string } | null;
}

function linkBareUrls(text: string): string {
  return text.replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, (_, pre: string, href: string) => {
    let label = href;
    try { const u = new URL(href); label = (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/$/, ""); } catch { /* keep it */ }
    return `${pre}[${label}](${href})`;
  });
}

/** A post as the reader's Markdown: its paragraphs, its photos (no avatars), and a quoted post as a quote. */
export function postMarkdown(post: FxPost, url: string): string {
  const parts = (post.text ?? "").split(/\n{2,}/).map((p) => linkBareUrls(p.trim())).filter(Boolean);
  for (const photo of post.media?.photos ?? []) parts.push(`![](${photo.url})`);
  for (const video of post.media?.videos ?? []) {
    if (video.thumbnail_url) parts.push(`![](${video.thumbnail_url})`);
    parts.push(`[Watch the video on X](${url})`);
  }
  const q = post.quote;
  if (q?.text) {
    const who = q.author?.name ? `**${q.author.name}**${q.author.screen_name ? ` @${q.author.screen_name}` : ""}` : "";
    parts.push([who, ...q.text.split(/\n+/).map((l) => linkBareUrls(l.trim())).filter(Boolean)].filter(Boolean).map((l) => `> ${l}`).join("\n"));
    for (const photo of q.media?.photos ?? []) parts.push(`![](${photo.url})`);
  }
  return parts.join("\n\n");
}

async function fxPost(url: string): Promise<FxPost | null> {
  const id = url.match(/\/status(?:es)?\/(\d+)/)?.[1];
  if (!id) return null;
  try {
    // FixTweet refuses requests without a User-Agent (401).
    const r = await fetch(`https://api.fxtwitter.com/status/${id}`,
      { headers: { "User-Agent": "anurag-os-reader/1.0" }, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    return ((await r.json()) as { tweet?: FxPost }).tweet ?? null;
  } catch { return null; }
}

interface OEmbed { title?: string; author_name?: string; html?: string; thumbnail_url?: string }

async function oembed(endpoint: string, url: string): Promise<OEmbed | null> {
  try {
    const r = await fetch(`${endpoint}?url=${encodeURIComponent(url)}&format=json&omit_script=1&dnt=true`,
      { redirect: "follow", signal: AbortSignal.timeout(8_000) });
    return r.ok ? await r.json() as OEmbed : null;
  } catch { return null; }
}

/** What a non-article is, from the place that knows best (X's and YouTube's embeds, the file name, arXiv). */
async function describeNonArticle(link: LinkRow): Promise<{ title: string; site?: string; body?: string; image?: string; excerpt?: string; whole?: boolean } | null> {
  const host = new URL(link.url).hostname.replace(/^www\./, "");
  const kind = linkKind(link.url, link.fetch_error);
  if (kind === "post" && /^(x\.com|twitter\.com)$/.test(host)) {
    // A plain post: FixTweet has all of it (X's embed cuts long posts off). A long-form
    // X Article came in whole from the page, so it's left as it is.
    const fx = await fxPost(link.url);
    if (fx?.text && !fx.article) {
      const body = postMarkdown(fx, link.url);
      return { title: titleFromText(fx.text) || `${fx.author?.name ?? "A post"} on X`, site: fx.author?.name, body,
        excerpt: fx.text.slice(0, 280), whole: true };
    }
    // A long-form X Article: the page brought the words; its own title is better than "Name on X".
    if (fx?.article?.title) return { title: fx.article.title, site: fx.author?.name };
    const o = await oembed("https://publish.twitter.com/oembed", link.url);
    if (!o?.html) return null;
    const text = postText(o.html);
    const truncated = text.endsWith("…");
    const body = text + (truncated ? `\n\n[Read the whole post on X](${link.url})` : "");
    return { title: titleFromText(text) || `${o.author_name ?? "A post"} on X`, site: o.author_name, body, excerpt: text.slice(0, 280) };
  }
  if (kind === "video") {
    const endpoint = /youtu/.test(host) ? "https://www.youtube.com/oembed" : /vimeo\.com$/.test(host) ? "https://vimeo.com/api/oembed.json" : null;
    const o = endpoint ? await oembed(endpoint, link.url) : null;
    return o?.title ? { title: o.title, site: o.author_name, image: o.thumbnail_url } : null;
  }
  if (kind === "pdf") {
    const arxiv = link.url.match(/arxiv\.org\/pdf\/([\w.\/-]+?)(?:\.pdf)?$/i)?.[1];
    if (arxiv) {
      try {
        const r = await fetch(`https://arxiv.org/abs/${arxiv}`, { signal: AbortSignal.timeout(8_000) });
        const t = r.ok ? extractArticle(await r.text(), `https://arxiv.org/abs/${arxiv}`).title : null;
        if (t) return { title: t.replace(/^\[[^\]]+\]\s*/, ""), site: "arXiv" };
      } catch { /* fall through to the file name */ }
    }
    const fromName = titleFromPdfUrl(link.url);
    return fromName ? { title: fromName } : null;
  }
  return null;
}

/** Fills in what a page fetch can't: posts' words, videos' titles, PDFs' names. Never fails the save. */
async function enrich(env: Env, id: string): Promise<void> {
  const link = await getLink(env, id);
  const extra = await describeNonArticle(link);
  if (!extra) {
    // Even when the site refused this time, what's stored loses its avatars and subscribe lines.
    const cleaned = cleanMarkdown(link.body ?? "");
    if (cleaned !== (link.body ?? "")) {
      await env.DB.prepare("UPDATE documents SET body = ?, version = version + 1 WHERE id = ?").bind(cleaned, id).run();
    }
    return;
  }
  const fm = link.frontmatter_json ? JSON.parse(link.frontmatter_json) : {};
  const body = link.body ?? "";
  // A long X post ("article") already came in whole, with a clean title: only add who wrote it.
  const alreadyWhole = !extra.whole && body.length > 600;
  const title = alreadyWhole && extra.body ? link.title : extra.title;
  const newBody = cleanMarkdown(extra.whole && extra.body ? extra.body
    : extra.body && !alreadyWhole ? `${extra.body}\n\n${body}`.trim() : body);
  const image = extra.image && !fm.image ? { image: extra.image } : {};
  await env.DB.batch([
    env.DB.prepare("UPDATE documents SET title = ?, body = ?, frontmatter_json = ?, version = version + 1 WHERE id = ?")
      .bind(title.slice(0, 300), newBody, JSON.stringify({ ...fm, ...image }), id),
    env.DB.prepare("UPDATE links SET site = COALESCE(?, site), excerpt = COALESCE(?, excerpt) WHERE document_id = ?")
      .bind(extra.site ?? null, alreadyWhole ? null : extra.excerpt ?? null, id),
  ]);
}

export async function fetchArticle(env: Env, id: string, now = new Date()): Promise<LinkRow> {
  const link = await getLink(env, id);
  const stamp = now.toISOString();
  try {
    const response = await fetch(link.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; anurag-os-reader/1.0)", Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`The site answered ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!/html|xml/i.test(type)) throw new Error(`Not a web page (${type.split(";")[0] || "unknown type"})`);
    let html = (await response.text()).slice(0, 3_000_000);
    let pageUrl = response.url || link.url;
    // A share or preview link (Substack's /p/<uuid>) is a different page from the post: follow its canonical address.
    const canonical = canonicalUrl(html, pageUrl);
    if (canonical && new URL(canonical).pathname !== new URL(pageUrl).pathname && /\/p\/[0-9a-f-]{36}\b/i.test(pageUrl)) {
      const again = await fetch(canonical, { headers: { "User-Agent": "Mozilla/5.0 (compatible; anurag-os-reader/1.0)", Accept: "text/html" },
        redirect: "follow", signal: AbortSignal.timeout(10_000) });
      if (again.ok) { html = (await again.text()).slice(0, 3_000_000); pageUrl = again.url || canonical; }
    }
    const fresh = extractArticle(html, pageUrl);
    // Never trade good text for worse: some sites (X especially) serve a stripped page now and then.
    const had = (link.body ?? "").length;
    const worse = had > 600 && fresh.markdown.length < had * 0.5;
    const article = worse ? { ...fresh, markdown: link.body ?? "", title: link.title, excerpt: link.excerpt ?? fresh.excerpt,
      words: Math.max(fresh.words, (link.reading_minutes ?? 1) * 230) } : fresh;
    const title = cleanTitle(article.title ?? link.title).slice(0, 300);
    await env.DB.batch([
      env.DB.prepare("UPDATE documents SET title = ?, body = ?, frontmatter_json = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .bind(title, article.markdown,
          JSON.stringify({ ...(link.frontmatter_json ? JSON.parse(link.frontmatter_json) : {}), url: link.url,
            ...(article.image ? { image: article.image } : {}), ...(article.icon ? { icon: article.icon } : {}) }),
          stamp, id),
      env.DB.prepare("UPDATE links SET site = ?, excerpt = ?, reading_minutes = ?, fetched_at = ?, fetch_error = NULL WHERE document_id = ?")
        .bind(article.site, article.excerpt, Math.max(1, Math.round(article.words / 230)), stamp, id),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare("UPDATE links SET fetch_error = ?, fetched_at = ? WHERE document_id = ?").bind(message.slice(0, 300), stamp, id).run();
  }
  try { await enrich(env, id); } catch { /* the page as fetched is still saved */ }
  return getLink(env, id);
}

/** Saves a URL once. Saving it again returns the same link (and brings it back if it was deleted). */
export async function saveLink(env: Env, rawUrl: string, now = new Date()): Promise<LinkRow> {
  const url = normalizeUrl(rawUrl);
  const existing = await env.DB.prepare("SELECT document_id FROM links WHERE url = ?").bind(url).first<{ document_id: string }>();
  if (existing) {
    await env.DB.prepare("UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL")
      .bind(now.toISOString(), existing.document_id).run();
    return getLink(env, existing.document_id);
  }
  const host = new URL(url).hostname.replace(/^www\./, "");
  const doc = await createDocument(env, { kind: "link", title: host, body: "", folder: "Links", frontmatter: { url } }, now);
  await env.DB.prepare("INSERT INTO links (document_id, url, site) VALUES (?, ?, ?)").bind(doc.id, url, host).run();
  return fetchArticle(env, doc.id, now);
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
