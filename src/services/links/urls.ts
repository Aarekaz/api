import { DocumentError } from "../documents";

// What a saved URL is: its clean form and what kind of page it points at.

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

export type LinkKind = "article" | "video" | "pdf" | "post";

/** An arXiv paper's id from an arXiv or alphaXiv link (/abs/ or /pdf/): the paper is its PDF, not the abstract page. */
export function arxivId(url: string): string | null {
  return url.match(/(?:arxiv|alphaxiv)\.org\/(?:abs|pdf|overview)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?(?:[?#].*)?$/i)?.[1] ?? null;
}

/** What kind of page a link is, so the apps can open it the right way. */
export function linkKind(url: string, fetchError: string | null = null): LinkKind {
  let host = "", path = "";
  try { const u = new URL(url); host = u.hostname.replace(/^(www|m|mobile)\./, "").toLowerCase(); path = u.pathname.toLowerCase(); } catch { /* article */ }
  if (/^(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|twitch\.tv|loom\.com)$/.test(host)) return "video";
  if (path.endsWith(".pdf") || /application\/pdf/i.test(fetchError ?? "") || arxivId(url)) return "pdf";
  if (/^(x\.com|twitter\.com|threads\.net|bsky\.app|instagram\.com)$/.test(host)) return "post";
  return "article";
}
