import type { Context, Next } from "hono";
import type { Env } from "../types/env";

/**
 * After a change the website shows, ask anuragd.me to rebuild just those
 * pages (POST /api/revalidate), so edits from the app appear in seconds
 * instead of each page's cache window (up to an hour).
 *
 * Off until REVALIDATE_TOKEN is set (the same value as the site's). Failures
 * never affect the response; the page's own cache window still catches up.
 *
 * "/", "/now", "/projects" and "/blog" also re-render the site's og:video
 * previews, so frequent small writes (shelf progress, autosaves of a live
 * post) only refresh their own pages; home picks those up in its 5 minutes.
 */

const SHELF = ["/shelf", "/shelf/books", "/shelf/movies", "/shelf/shows", "/shelf/quotes",
  "/shelf/links", "/shelf/visuals", "/shelf/wallpapers"];

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The site pages a successful write to `path` changes, before looking at the response. */
export function pagesFor(method: string, path: string): string[] {
  if (!WRITES.has(method)) return [];
  const p = path.replace(/\/+$/, "");
  const under = (prefix: string) => p === prefix || p.startsWith(prefix + "/");
  if (under("/v1/profile") || under("/v1/site/profile")) return ["/", "/resume"];
  if (under("/v1/now")) return ["/now"];
  if (under("/v1/projects")) return ["/", "/projects"];
  if (under("/v1/posts")) return ["/", "/blog"];
  if (under("/v1/shelf") || under("/v1/site/shelf-sections") || under("/v1/settings")) return SHELF;
  if (under("/v1/photos")) return ["/photography"];
  if (under("/v1/uses")) return ["/uses"];
  if (under("/v1/experience") || under("/v1/education") || under("/v1/skills")) return ["/resume"];
  // Publishing or unpublishing writing changes the blog list and home.
  if (/^\/v1\/documents\/[^/]+\/(publish|unpublish)$/.test(p)) return ["/", "/blog"];
  return [];
}

type DocumentLike = { kind?: string; status?: string; post_id?: number | null };

async function postSlug(env: Env, postId: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT slug FROM posts WHERE id = ?").bind(postId).first<{ slug: string }>();
  return row?.slug ?? null;
}

/** Everything to refresh for this request, including a post's own page when one changed. */
export async function pagesForResponse(c: Context<{ Bindings: Env }>): Promise<string[]> {
  const method = c.req.method, path = c.req.path.replace(/\/+$/, "");
  const pages = pagesFor(method, path);
  const isDocument = /^\/v1\/documents\/[^/]+(\/(publish|unpublish))?$/.test(path) && method !== "DELETE";
  if (!isDocument) return pages;
  // A saved document matters only if it is (or just stopped being) a post on the site.
  const doc = (await c.res.clone().json().catch(() => null)) as DocumentLike | null;
  const changesPost = doc?.kind === "writing" && doc.post_id != null && (doc.status === "published" || pages.length > 0);
  if (!changesPost) return pages;
  const slug = await postSlug(c.env, doc!.post_id!).catch(() => null);
  return slug && /^[a-z0-9-]+$/.test(slug) ? [...pages, `/blog/${slug}`, `/blog/${slug}.md`] : pages;
}

export async function siteRefresh(c: Context<{ Bindings: Env }>, next: Next) {
  await next();
  const token = c.env.REVALIDATE_TOKEN;
  if (!token || !WRITES.has(c.req.method) || c.res.status >= 400) return;
  const send = (async () => {
    try {
      const paths = await pagesForResponse(c);
      if (paths.length === 0) return;
      const site = (c.env.SITE_URL || "https://www.anuragd.me").replace(/\/+$/, "");
      const res = await fetch(`${site}/api/revalidate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [...new Set(paths)] }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) console.warn(JSON.stringify({ event: "site_refresh_failed", status: res.status }));
    } catch (error) {
      console.warn(JSON.stringify({ event: "site_refresh_failed", error: String(error) }));
    }
  })();
  // Don't hold the response for the site; fall back to awaiting where there's no execution context (tests).
  try { c.executionCtx.waitUntil(send); } catch { await send; }
}
