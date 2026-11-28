import type { Context, Next } from "hono";

/**
 * Strong ETags from the reply's own bytes, for the large lists the apps read
 * at launch (documents, links, journal, shelf, posts) and Wrapped's summary.
 *
 * The body is still built (these reads have no data version to check first),
 * but a client that already has it gets a 304 with no body, which is where
 * the time goes on a phone: the lists run to megabytes. `private, no-cache`
 * lets the client keep the body and ask each time; no shared cache keeps it.
 *
 * Only a 200 JSON reply to a GET is tagged. A reply that already has an ETag
 * is left alone, and so is anything else (images, errors, writes).
 *
 * The documents list starts with `server_time`, the clock at the reply, so no
 * two bodies are alike. Its tag is taken over the rest of the body and is
 * weak (W/): a 304 means the rows are the same, and the copy the client keeps
 * has an older server_time, which is the safe direction for a sync cursor.
 */
export const BODY_ETAG_PREFIXES = [
  "/v1/documents", "/v1/links", "/v1/journal", "/v1/shelf", "/v1/posts", "/v1/wrapped/summary", "/v1/watch",
] as const;

const CACHE_CONTROL = "private, no-cache";
const SERVER_TIME = /^\{"server_time":"[^"]*",/;

export function underBodyEtag(path: string): boolean {
  return BODY_ETAG_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}

export async function bodyEtag(c: Context, next: Next) {
  await next();
  if (c.req.method !== "GET" || !underBodyEtag(c.req.path)) return;
  const res = c.res;
  if (res.status !== 200 || res.headers.has("ETag")) return;
  if (!(res.headers.get("Content-Type") ?? "").includes("json")) return;

  const bytes = await res.clone().arrayBuffer();
  const text = new TextDecoder().decode(bytes);
  const steady = text.replace(SERVER_TIME, "{");
  const etag = steady === text ? await strongTag(bytes) : `W/${await strongTag(new TextEncoder().encode(steady))}`;
  if (matches(c.req.header("If-None-Match"), etag)) {
    c.res = new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": CACHE_CONTROL } });
    return;
  }
  const headers = new Headers(res.headers);
  headers.set("ETag", etag);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", CACHE_CONTROL);
  c.res = new Response(bytes, { status: res.status, headers });
}

/** `"<22 base64url characters>"`: the first 128 bits of SHA-256 over the body. */
export async function strongTag(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const text = btoa(String.fromCharCode(...digest.subarray(0, 16))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `"${text}"`;
}

/** If-None-Match compares weakly (RFC 9110 13.1.2): a W/ the edge may add still matches. */
function matches(sent: string | undefined, etag: string): boolean {
  if (!sent) return false;
  if (sent.trim() === "*") return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return sent.split(",").some((tag) => bare(tag) === bare(etag));
}
