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

/** An image as Markdown, or "" for tracking pixels and inline data. */
function imageMarkdown(tag: string, base: string): string {
  const src = absolute(attr(tag, "src") ?? attr(tag, "data-src") ?? attr(tag, "srcset")?.split(/[\s,]/)[0], base);
  if (!src) return "";
  const width = Number(attr(tag, "width") ?? "0");
  if (width > 0 && width < 40) return "";
  const alt = decodeEntities(attr(tag, "alt") ?? "").replace(/[\[\]]/g, "").trim();
  return `![${alt}](${src})`;
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

  // Images become their own paragraphs, so the reader can show them in place.
  const withImages = scope.replace(/<img\b[^>]*>/gi, (tag) => {
    const md = imageMarkdown(tag, url);
    return md ? `<p>${md}</p>` : "";
  });

  const lines: string[] = [];
  for (const m of withImages.matchAll(/<(h[1-6]|p|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
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

interface LinkRow extends DocumentRow {
  url: string; site: string | null; excerpt: string | null; reading_minutes: number | null;
  read_at: string | null; fetched_at: string | null; fetch_error: string | null;
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
    ...(includeBody ? { body: row.body } : {}),
  };
}

const SELECT = `SELECT d.*, l.url, l.site, l.excerpt, l.reading_minutes, l.read_at, l.fetched_at, l.fetch_error
  FROM links l JOIN documents d ON d.id = l.document_id`;

export async function getLink(env: Env, id: string): Promise<LinkRow> {
  const row = await env.DB.prepare(`${SELECT} WHERE d.id = ? AND d.deleted_at IS NULL`).bind(id).first<LinkRow>();
  if (!row) throw new DocumentError("Link not found", 404);
  return row;
}

export async function listLinks(env: Env, state: "unread" | "read" | "starred" | "all" = "all", limit = 500): Promise<LinkRow[]> {
  const filter = state === "unread" ? " AND l.read_at IS NULL" : state === "read" ? " AND l.read_at IS NOT NULL"
    : state === "starred" ? " AND json_extract(d.frontmatter_json, '$.starred_at') IS NOT NULL" : "";
  const { results } = await env.DB.prepare(
    `${SELECT} WHERE d.deleted_at IS NULL${filter} ORDER BY d.created_at DESC LIMIT ?`,
  ).bind(Math.min(Math.max(limit, 1), 2000)).all<LinkRow>();
  return results;
}

/** Fetches the page and stores its readable text. Failures are recorded, not thrown. */
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
    const html = (await response.text()).slice(0, 3_000_000);
    const article = extractArticle(html, response.url || link.url);
    const title = (article.title ?? link.title).slice(0, 300);
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
    env.DB.prepare("UPDATE links SET read_at = ? WHERE document_id = ?").bind(read ? stamp : null, id),
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
