import { decodeEntities, extractArticle } from "./extract";
import type { LinkRow } from "./store";
import { arxivId, linkKind } from "./urls";

// Posts, videos and PDFs: what they are, from the place that knows best
// (X's and FixTweet's posts, YouTube's and Vimeo's embeds, file names, arXiv).

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
  article?: XArticle | null;
}

/** An X Article as FixTweet gives it: Draft.js blocks, an entity list (links, pictures, posts), the pictures. */
export interface XArticle {
  title?: string;
  cover_media?: { media_info?: { original_img_url?: string } };
  content?: {
    blocks: Array<{ type: string; text: string; inlineStyleRanges?: Array<{ offset: number; length: number; style: string }>;
      entityRanges?: Array<{ offset: number; length: number; key: number | string }> }>;
    entityMap?: Array<{ key: string; value: { type: string; data: Record<string, unknown> } }> | Record<string, { type: string; data: Record<string, unknown> }>;
  };
  media_entities?: Array<{ media_id?: string; media_info?: { original_img_url?: string } }>;
}

/** An X Article as the reader's Markdown: headings, lists, quotes, code, bold/italic, links and pictures in place. */
export function xArticleMarkdown(article: XArticle): string {
  const blocks = article.content?.blocks ?? [];
  const map = article.content?.entityMap ?? [];
  const entity = (key: number | string) => Array.isArray(map) ? map.find((e) => String(e.key) === String(key))?.value : map[String(key)];
  const pictures = new Map((article.media_entities ?? []).map((m) => [m.media_id, m.media_info?.original_img_url]));
  const styled = (b: (typeof blocks)[number]) => {
    // Cut the text at every place a style or link starts or ends, then wrap each piece.
    const cuts = new Set([0, b.text.length]);
    for (const r of [...(b.inlineStyleRanges ?? []), ...(b.entityRanges ?? [])]) { cuts.add(r.offset); cuts.add(r.offset + r.length); }
    const points = [...cuts].sort((x, y) => x - y);
    let out = "";
    for (let i = 0; i < points.length - 1; i++) {
      const [from, to] = [points[i], points[i + 1]];
      let piece = b.text.slice(from, to);
      if (!piece.trim()) { out += piece; continue; }
      const within = (r: { offset: number; length: number }) => r.offset <= from && r.offset + r.length >= to;
      const styles = (b.inlineStyleRanges ?? []).filter(within).map((r) => r.style.toLowerCase());
      const lead = piece.match(/^\s*/)![0], trail = piece.match(/\s*$/)![0];
      piece = piece.trim();
      if (styles.includes("code")) piece = `\`${piece}\``;
      if (styles.includes("bold")) piece = `**${piece}**`;
      if (styles.includes("italic")) piece = `*${piece}*`;
      const link = (b.entityRanges ?? []).filter(within).map((r) => entity(r.key)).find((e) => e?.type === "LINK");
      const url = link?.data?.url;
      if (typeof url === "string") piece = `[${piece.replace(/[\[\]]/g, "")}](${url})`;
      out += lead + piece + trail;
    }
    return out.trim();
  };
  const out: string[] = [];
  let n = 0;
  for (const b of blocks) {
    if (b.type !== "ordered-list-item") n = 0;
    if (b.type === "atomic") {
      for (const r of b.entityRanges ?? []) {
        const e = entity(r.key);
        if (e?.type === "MEDIA") {
          for (const item of (e.data.mediaItems as Array<{ mediaId?: string }> | undefined) ?? []) {
            const src = pictures.get(item.mediaId);
            if (src) out.push(`![](${src})`);
          }
        } else if (e?.type === "TWEET" && e.data.tweetId) {
          out.push(`> [A post on X](https://x.com/i/status/${e.data.tweetId})`);
        }
      }
      continue;
    }
    if (b.type === "code-block") { if (b.text.trim()) out.push("```\n" + b.text + "\n```"); continue; }
    const text = styled(b);
    if (!text) continue;
    if (/^header-/.test(b.type)) out.push(`## ${text.replace(/\*\*/g, "")}`);
    else if (b.type === "unordered-list-item") out.push(`- ${text}`);
    else if (b.type === "ordered-list-item") out.push(`${++n}. ${text}`);
    else if (b.type === "blockquote") out.push(`> ${text}`);
    else out.push(text);
  }
  return out.join("\n\n");
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
export async function describeNonArticle(link: LinkRow): Promise<{ title: string; site?: string; body?: string; image?: string; excerpt?: string; whole?: boolean } | null> {
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
    // A long-form X Article: built from its own blocks (X's web page can change under us any day).
    if (fx?.article?.content?.blocks?.length) {
      const body = xArticleMarkdown(fx.article);
      if (body.length > 200) {
        return { title: fx.article.title || titleFromText(body), site: fx.author?.name, body, whole: true,
          image: fx.article.cover_media?.media_info?.original_img_url, excerpt: body.replace(/[#*>\[\]]|\(https?:[^)]*\)/g, "").slice(0, 280) };
      }
    }
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
    const arxiv = arxivId(link.url);
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
