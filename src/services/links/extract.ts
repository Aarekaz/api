// A page's HTML as the reader's Markdown: the article, its title, picture and
// site, without menus, avatars and newsletter furniture. Pure functions, no I/O.

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
  return /\/profile_images\/|[,!\/]w_\d{1,2},h_\d{1,2}[,\/]|\/avatars?\/|gravatar\.com\/avatar|googleusercontent\.com\/a\/|=s\d{2}-c\b|\/i\/logo\//i.test(src)
    || /^(x |twitter )?avatar\b|^avatar for |avatar$|\blogo$|^footer\b/i.test(alt)
    // A template the page never filled in ("$store.lightbox.src", "{{image}}").
    || /\$store\.|\{\{|%7B%7B/i.test(src);
}

/** A block that's only links to social networks ("- [LinkedIn](…)", "YouTube · Instagram · TikTok"). */
function isSocialLinks(block: string): boolean {
  const links = [...block.matchAll(/\[([^\]]+)\]\([^)]*\)/g)].map((m) => m[1].trim().toLowerCase().replace(/[,.]$/, ""));
  if (links.length === 0) return false;
  const rest = block.replace(/\[([^\]]+)\]\([^)]*\)/g, "").replace(/[-*·•|,\s]/g, "");
  const networks = /^(linkedin|x|twitter|youtube|instagram|tiktok|facebook|github|threads|bluesky|mastodon|email|rss|substack|spotify|apple podcasts|reddit|discord)$/;
  return rest.length === 0 && links.every((l) => networks.test(l));
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
    .replace(/^(#{1,6} |- |> )/, "").replace(/[*_]/g, "").trim();
  if (text.length > 200) return false;
  return /\b(subscribe|subscribed|paid subscriber)\b/i.test(text)
    || /^thanks for reading\b/i.test(text)
    || /^get \d+% off\b/i.test(text)
    || /copy shortlink|manage subscriptions|view post in reader|report this content/i.test(text)
    || /^(share|like|comment|restack|sign up|sign in|log in|discussion about this post|related|leave a comment|get my newsletter|newsletter)$/i.test(text)
    || /^share on (facebook|x|twitter|linkedin|reddit|threads|bluesky|email)\b|opens in new window|have a wordpress\.com account|already on my mailing list|reader-supported publication|^the rich text element allows you/i.test(text);
}

/** Stored Markdown with avatars and newsletter furniture taken out (for text saved before the rules existed). */
export function cleanMarkdown(markdown: string, url?: string): string {
  const seen = new Set<string>();
  let path: string | null = null;
  try { path = url ? new URL(url).pathname.replace(/\/$/, "") : null; } catch { /* keep null */ }
  const blocks = markdown.split("\n\n").map((b) => b.trim()).filter((block) => {
    if (!block) return false;
    const image = block.match(/^!\[([^\]]*)\]\((\S+)\)$/);
    if (image) {
      if (isAvatar(image[2], image[1])) return false;
    } else if (isBoilerplate(block) || isSocialLinks(block)) return false;
    // A heading that is only a link to another page is a "related posts" card, not a section.
    const linkHeading = block.match(/^#{1,6} \[[^\]]+\]\(([^)]+)\)$/);
    if (linkHeading && !linkHeading[1].includes("#")) {
      try { if (new URL(linkHeading[1]).pathname.replace(/\/$/, "") !== path) return false; } catch { return false; }
    }
    // Pages that render the story twice (a mobile and a desktop copy) or repeat a card: keep the first.
    if (block.length >= 40 && !block.startsWith("```")) {
      if (seen.has(block)) return false;
      seen.add(block);
    }
    return true;
  });
  // A run of three or more pictures at the very end is a row of thumbnails or logos, not the story.
  let end = blocks.length;
  while (end > 0 && /^!\[/.test(blocks[end - 1])) end--;
  if (blocks.length - end >= 3) blocks.splice(end);
  return unwrapRedirects(blocks.join("\n\n"));
}

/** Links that go through a tracker first (Google Docs' google.com/url?q=…, Facebook's l.php?u=…) point at where they go. */
export function unwrapRedirects(markdown: string): string {
  return markdown.replace(/\]\((https?:\/\/(?:www\.)?(?:google\.com\/url\?q=|l\.facebook\.com\/l\.php\?u=)([^)&\s]+)[^)\s]*)\)/g,
    (whole, _url: string, target: string) => {
      try { const real = decodeURIComponent(target); return /^https?:\/\//.test(real) ? `](${real})` : whole; } catch { return whole; }
    });
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

/**
 * Pages without an <article> tag bring their shop, menus and newsletter boxes along.
 * The story runs from the first real paragraph to the last one, so cut what's outside
 * (keeping a heading or image that leads straight into it).
 */
export function trimToArticle(lines: string[]) {
  const isProse = (l: string) => !/^(#{1,6} |- |> |!\[|```|\| )/.test(l)
    && l.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").length >= 100;
  const first = lines.findIndex(isProse);
  if (first < 0) return;
  let last = lines.length - 1;
  while (last > first && !isProse(lines[last]) && !/^(- |\d+\. |> |```|!\[|\| )/.test(lines[last])) last--;
  let start = first;
  while (start > 0 && start > first - 2 && /^(#{1,6} |!\[)/.test(lines[start - 1])) start--;
  lines.splice(last + 1);
  lines.splice(0, start);
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

  // Data tables become Markdown tables, held aside so the paragraph pass leaves them whole.
  const tables: string[] = [];
  const withTables = scope.replace(/<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/gi, (whole, inner: string) => {
    const md = tableMarkdown(inner, url);
    if (!md) return whole;
    tables.push(md);
    return `<mdtable>${tables.length - 1}</mdtable>`;
  });
  // Numbered lists keep their numbers: each <li> directly in an <ol> carries its place.
  const withNumbers = withTables.replace(/<ol\b([^>]*)>([\s\S]*?)<\/ol>/gi, (_, attrs: string, inner: string) => {
    let n = Number(attr(`<ol ${attrs}>`, "start") ?? "1") - 1;
    if (!Number.isFinite(n)) n = 0;
    return inner.replace(/<li\b/gi, () => `<li data-n="${++n}"`);
  });
  // Images become their own paragraphs, so the reader can show them in place.
  const withImages = withNumbers.replace(/<img\b[^>]*>/gi, (tag) => {
    const md = imageMarkdown(tag, url);
    return md ? `<p>${md}</p>` : "";
  });

  const lines: string[] = [];
  for (const m of withImages.matchAll(/<(h[1-6]|p|li|blockquote|pre|mdtable)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    const number = tag === "li" ? attr(`<li ${m[2]}>`, "data-n") : undefined;
    const bullet = number ? `${number}. ` : "- ";
    if (tag === "mdtable") { lines.push(tables[Number(m[3])]); continue; }
    if (tag === "pre") {
      const code = decodeEntities(m[3].replace(/<[^>]+>/g, "")).trimEnd();
      if (code.trim()) lines.push("```\n" + code + "\n```");
      continue;
    }
    // An image wrapped in a paragraph that already holds text splits into both.
    const inner = m[3].replace(/<p>(!\[[^\]]*\]\([^)]+\))<\/p>/g, "\n$1\n");
    if (inner.includes("![")) {
      for (const part of inner.split("\n")) {
        const image = part.match(/^!\[[^\]]*\]\([^)]+\)$/);
        if (image) { lines.push(image[0]); continue; }
        const piece = inline(part, url);
        if (piece.length >= 2) lines.push(tag[0] === "h" ? `${headingMarks(tag)} ${piece}` : tag === "li" ? `${bullet}${piece}` : tag === "blockquote" ? `> ${piece}` : piece);
      }
      continue;
    }
    // Code keeps its words as they are; everything else keeps bold, italics and links.
    const text = inline(m[3], url);
    if (text.length < 2) continue;
    if (tag[0] === "h") lines.push(`${headingMarks(tag)} ${text}`);
    else if (tag === "li") lines.push(`${bullet}${text}`);
    else if (tag === "blockquote") lines.push(`> ${text}`);
    else lines.push(text);
  }
  for (let i = lines.length - 1; i >= 0; i--) if (isBoilerplate(lines[i])) lines.splice(i, 1);
  trimToArticle(lines);
  // Drop a leading heading that only repeats the title.
  if (title && lines[0]?.replace(/^#{1,6} /, "").replace(/\*/g, "") === title) lines.shift();
  // Long reads are long (a 147-minute essay is ~600k characters); documents hold up to 1M.
  const markdown = cleanMarkdown(lines.join("\n\n"), url).slice(0, 950_000);
  const words = markdown.replace(/!\[[^\]]*\]\([^)]+\)/g, "").split(/\s+/).filter(Boolean).length;
  const lead = absolute(meta.get("og:image") || meta.get("twitter:image"), url);
  // A profile picture isn't a cover (X gives the author's face as the page's picture).
  const image = lead && !isAvatar(lead) ? lead : null;
  const iconTag = (html.match(/<link\b[^>]*rel\s*=\s*["'][^"']*(apple-touch-icon|icon)[^"']*["'][^>]*>/gi) ?? [])
    .sort((a, b) => Number(/apple-touch-icon/i.test(b)) - Number(/apple-touch-icon/i.test(a)))[0];
  let icon = iconTag ? absolute(attr(iconTag, "href"), url) : null;
  if (!icon) { try { icon = new URL("/favicon.ico", url).toString(); } catch { icon = null; } }
  const excerpt = meta.get("og:description") || meta.get("description") || lines.find((l) => !l.startsWith("#") && !l.startsWith("![") && l.length > 60)?.replace(/\*\*?|\[|\]\([^)]*\)/g, "").slice(0, 280) || null;
  return { title, site, excerpt, markdown, words, image, icon };
}

/** The page's own address for itself (<link rel="canonical"> or og:url). */
export function canonicalUrl(html: string, base: string): string | null {
  const tag = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i)?.[0];
  return absolute(tag ? attr(tag, "href") : metaTags(html).get("og:url"), base);
}

/**
 * Titles sites give their pages for sharing, cleaned for a reading list:
 * `Dhravya Shah on X: "Jev changes a lot" / X` becomes the quoted words.
 */
export function cleanTitle(title: string): string {
  const x = title.match(/^(.+?) on (?:X|Twitter): ["“](.+)["”]\s*\/\s*(?:X|Twitter)$/s);
  if (x) return x[2].trim();
  return title.trim();
}


/** The page's own heading level as Markdown marks (h2 → "##"), so the reader keeps the outline's hierarchy. */
function headingMarks(tag: string): string {
  const level = Number(tag[1]);
  return "#".repeat(Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2);
}
