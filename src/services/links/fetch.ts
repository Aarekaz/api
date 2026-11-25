import type { Env } from "../../types/env";
import { createDocument } from "../documents";
import { canonicalUrl, cleanMarkdown, cleanTitle, extractArticle, isAvatar } from "./extract";
import { describeNonArticle } from "./nonarticles";
import { getLink, type LinkRow } from "./store";
import { linkKind, normalizeUrl } from "./urls";

// Saving a link and fetching its page: once on save (after the reply when it can),
// again on request or with the page a device fetched; non-articles are filled in after.

/** Fills in what a page fetch can't: posts' words, videos' titles, PDFs' names. Never fails the save. */
async function enrich(env: Env, id: string): Promise<void> {
  const link = await getLink(env, id);
  const extra = await describeNonArticle(link);
  if (!extra) {
    // Even when the site refused this time, what's stored loses its avatars and subscribe lines.
    const cleaned = cleanMarkdown(link.body ?? "", link.url);
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
  const image = extra.image && (!fm.image || isAvatar(String(fm.image))) ? { image: extra.image } : {};
  await env.DB.batch([
    env.DB.prepare("UPDATE documents SET title = ?, body = ?, frontmatter_json = ?, version = version + 1 WHERE id = ?")
      .bind(title.slice(0, 300), newBody, JSON.stringify(withoutAvatarCover({ ...fm, ...image })), id),
    env.DB.prepare("UPDATE links SET site = COALESCE(?, site), excerpt = COALESCE(?, excerpt) WHERE document_id = ?")
      .bind(extra.site ?? null, alreadyWhole ? null : extra.excerpt ?? null, id),
  ]);
}

/** A cover saved before avatars were told apart from pictures comes off. */
function withoutAvatarCover(fm: Record<string, unknown>): Record<string, unknown> {
  if (typeof fm.image === "string" && isAvatar(fm.image)) { const { image: _, ...rest } = fm; return rest; }
  return fm;
}

/** Too little text to be the article: a bot check, a login wall, or a page built in the browser. */
export const THIN_PAGE = "Too little text came back (the site may block servers)";

/** Cloudflare's, Substack's and others' "are you a person" pages. */
export function isBotCheck(text: string): boolean {
  return /just a moment|enable javascript and cookies|checking (if the site connection is secure|your browser)|verify (you are|you're) (a )?human|access denied|are you a robot|attention required/i.test(text);
}

/**
 * Fetches the article and stores its text. `page` is the page as a device fetched it, for
 * sites that turn servers away (Substack answers Cloudflare with 429): the same reading
 * and cleaning, just without the server's own request.
 */
export async function fetchArticle(env: Env, id: string, now = new Date(), page?: { html: string; url?: string }): Promise<LinkRow> {
  const link = await getLink(env, id);
  const stamp = now.toISOString();
  try {
    let html: string, pageUrl: string;
    if (page) {
      html = page.html.slice(0, 3_000_000);
      pageUrl = page.url && /^https?:\/\//.test(page.url) ? page.url : link.url;
    } else {
      const response = await fetch(link.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; anurag-os-reader/1.0)", Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`The site answered ${response.status}`);
      const type = response.headers.get("content-type") ?? "";
      if (!/html|xml/i.test(type)) throw new Error(`Not a web page (${type.split(";")[0] || "unknown type"})`);
      html = (await response.text()).slice(0, 3_000_000);
      pageUrl = response.url || link.url;
    }
    // A share or preview link (Substack's /p/<uuid>) is a different page from the post: follow its canonical address.
    const canonical = canonicalUrl(html, pageUrl);
    if (canonical && new URL(canonical).pathname !== new URL(pageUrl).pathname && /\/p\/[0-9a-f-]{36}\b/i.test(pageUrl)) {
      const again = await fetch(canonical, { headers: { "User-Agent": "Mozilla/5.0 (compatible; anurag-os-reader/1.0)", Accept: "text/html" },
        redirect: "follow", signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (again?.ok) { html = (await again.text()).slice(0, 3_000_000); pageUrl = again.url || canonical; }
    }
    const fresh = extractArticle(html, pageUrl);
    // An article that came back nearly empty, or as a bot check, failed whatever the status said:
    // keep what's there, mark it, and a device fetches it from its own connection.
    const isArticle = linkKind(link.url) === "article";
    // A bot check isn't the page at all: leave the title and text as they were.
    if (isArticle && fresh.words < 200 && isBotCheck(fresh.markdown + " " + (fresh.title ?? ""))) throw new Error(THIN_PAGE);
    const thin = isArticle && fresh.words < 15;
    // Never trade good text for worse: some sites (X especially) serve a stripped page now and then.
    const had = (link.body ?? "").length;
    const worse = had > 600 && fresh.markdown.length < had * 0.5;
    const article = worse ? { ...fresh, markdown: link.body ?? "", title: link.title, excerpt: link.excerpt ?? fresh.excerpt,
      words: Math.max(fresh.words, (link.reading_minutes ?? 1) * 230) } : fresh;
    const title = cleanTitle(article.title ?? link.title).slice(0, 300);
    await env.DB.batch([
      env.DB.prepare("UPDATE documents SET title = ?, body = ?, frontmatter_json = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .bind(title, article.markdown,
          JSON.stringify(withoutAvatarCover({ ...(link.frontmatter_json ? JSON.parse(link.frontmatter_json) : {}), url: link.url,
            ...(article.image ? { image: article.image } : {}), ...(article.icon ? { icon: article.icon } : {}) })),
          stamp, id),
      env.DB.prepare("UPDATE links SET site = ?, excerpt = ?, reading_minutes = ?, fetched_at = ?, fetch_error = ? WHERE document_id = ?")
        .bind(article.site, article.excerpt, Math.max(1, Math.round(article.words / 230)), stamp, thin && !worse ? THIN_PAGE : null, id),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare("UPDATE links SET fetch_error = ?, fetched_at = ? WHERE document_id = ?").bind(message.slice(0, 300), stamp, id).run();
  }
  try { await enrich(env, id); } catch { /* the page as fetched is still saved */ }
  return getLink(env, id);
}

/**
 * Saves a URL once. Saving it again returns the same link (and brings it back if it was deleted).
 * A new link's page is fetched before this returns, unless `later` is given (the request's
 * waitUntil): then it's fetched after the reply and the link comes back with fetched_at null.
 */
export async function saveLink(env: Env, rawUrl: string, now = new Date(), later?: (work: Promise<unknown>) => void): Promise<LinkRow> {
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
  if (!later) return fetchArticle(env, doc.id, now);
  later(fetchArticle(env, doc.id, now).catch((error) => console.error("link fetch failed", error)));
  return getLink(env, doc.id);
}
