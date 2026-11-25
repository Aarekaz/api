import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { parseJson } from "../utils/json";

/**
 * Replies for the app's routes (links, journal, highlights, sections, documents,
 * visits, recipes, training, music history). One error shape:
 *
 *   { "error": { "code": "not_found", "message": "Document not found", "details"?: ... } }
 *
 * plus any extra top-level fields a route needs (a 409 on a document carries
 * `latest`). Routes the website reads (profile, projects, posts, photos, shelf,
 * settings, now, uses, skills, experience, education, github, wakatime, wrapped,
 * traffic, status, music/now, health/whoop) keep their old bodies, `error` a
 * string, and never use this file.
 */

export type ErrorCode =
  | "invalid" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "too_large"
  | "unsupported" | "unprocessable" | "rate_limited" | "server" | "upstream" | "unavailable" | (string & {});

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

const CODES: Record<number, ErrorCode> = {
  400: "invalid", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large",
  415: "unsupported", 422: "unprocessable", 429: "rate_limited", 500: "server", 502: "upstream", 503: "unavailable",
};

/** The code a status gets when the route doesn't name one. */
export const codeFor = (status: number): ErrorCode => CODES[status] ?? (status >= 500 ? "server" : "invalid");

/** Throw from anywhere in a handler; `failWith` turns it into the error reply. */
export class HttpError extends Error {
  constructor(readonly status: ContentfulStatusCode, message: string, readonly code: ErrorCode = codeFor(status), readonly details?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

type AnyContext = Context<any, any, any>;

/** A successful JSON reply. */
export function ok<T>(c: AnyContext, data: T, status: ContentfulStatusCode = 200) {
  return c.json(data as never, status);
}

/** An error reply in the one shape. `extra` adds top-level fields beside `error`. */
export function fail(
  c: AnyContext,
  status: ContentfulStatusCode,
  message: string,
  options: { code?: ErrorCode; details?: unknown; extra?: Record<string, unknown> } = {},
) {
  const error: ErrorBody["error"] = { code: options.code ?? codeFor(status), message };
  if (options.details !== undefined) error.details = options.details;
  return c.json({ ...options.extra, error } as never, status);
}

const zodMessage = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

/**
 * The reply for anything a handler threw: an HttpError, a Zod error (400), or a
 * service error that carries its own `status` (and maybe `code`), such as
 * DocumentError or SectionError. Anything else is logged and becomes a 500
 * that says only which request failed (`what`).
 */
export function failWith(c: AnyContext, error: unknown, what = "Request") {
  if (error instanceof HttpError) return fail(c, error.status, error.message, { code: error.code, details: error.details });
  if (error instanceof z.ZodError) return fail(c, 400, zodMessage(error), { code: "invalid" });
  if (error instanceof Error) {
    const { status, code } = error as Error & { status?: unknown; code?: unknown };
    if (typeof status === "number" && status >= 400 && status <= 599) {
      return fail(c, status as ContentfulStatusCode, error.message, { code: typeof code === "string" ? code : codeFor(status) });
    }
  }
  console.error(`${what} failed`, error);
  return fail(c, 500, `${what} failed`, { code: "server" });
}

/** A value checked against a schema; a mismatch is a 400 with each problem in the message. */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, zodMessage(result.error), "invalid");
  return result.data;
}

/** The request's JSON body, optionally checked against a schema. Unreadable JSON is a 400. */
export async function body<S extends z.ZodTypeAny = z.ZodUnknown>(c: AnyContext, schema?: S): Promise<z.infer<S>> {
  const json = await parseJson(c.req.raw);
  if (json === null) throw new HttpError(400, "Invalid JSON", "invalid");
  return schema ? parse(schema, json) : json;
}

/**
 * The request's waitUntil, to finish work after the reply, or undefined where
 * there is no execution context (tests, `app.request`). Callers then do the
 * work before replying.
 */
export function later(c: AnyContext): ((work: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (work) => ctx.waitUntil(work);
  } catch {
    return undefined;
  }
}

// MARK: Lists and cursors

/**
 * Lists on the app's routes answer `{ <name>: [...], items: [...], next_cursor }`:
 * the old named key stays (the app moves to `items`; the named key goes a
 * release later), `next_cursor` is null on the last page. Pass it back as
 * `?cursor=` for the next page.
 */
export function list<T>(c: AnyContext, key: string, items: T[], next_cursor: string | null, extra: Record<string, unknown> = {}) {
  return c.json({ [key]: items, ...extra, items, next_cursor } as never);
}

/** `?limit=` between 1 and `max`, `fallback` when missing or not a number. */
export function limitFrom(c: AnyContext, fallback: number, max: number): number {
  return Math.min(Math.max(Math.floor(Number(c.req.query("limit"))) || fallback, 1), max);
}

/** Opaque cursor: the sort values of the last row on the page. */
export function encodeCursor(values: unknown[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `?cursor=` decoded to `size` sort values, null when absent. A bad cursor is a 400. */
export function cursorFrom(c: AnyContext, size: number): Array<string | number> | null {
  const raw = c.req.query("cursor");
  if (!raw) return null;
  try {
    const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const values = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0))));
    if (Array.isArray(values) && values.length === size && values.every((v) => typeof v === "string" || typeof v === "number")) return values;
  } catch { /* falls through */ }
  throw new HttpError(400, "cursor is not one this API gave out", "invalid");
}

/**
 * One page from rows fetched with LIMIT limit + 1: the first `limit` rows, and
 * a cursor from the last of them when there was a row beyond.
 */
export function page<T>(rows: T[], limit: number, cursorOf: (row: T) => unknown[]) {
  const items = rows.slice(0, limit);
  const next_cursor = rows.length > limit && items.length ? encodeCursor(cursorOf(items[items.length - 1])) : null;
  return { items, next_cursor };
}

// MARK: Conditional GETs

/**
 * ETag / If-None-Match. Sets the tag (and `Cache-Control: private, no-cache`,
 * so a client keeps the body but asks every time) and answers 304 with no body
 * when the client already has this version. Returns null when the handler
 * should go on and build the body.
 */
export function notModified(c: AnyContext, etag: string): Response | null {
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  const sent = c.req.header("If-None-Match");
  if (!sent) return null;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  const match = sent.trim() === "*" || sent.split(",").some((tag) => bare(tag) === bare(etag));
  if (!match) return null;
  return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
}

/** A short stable hash (FNV-1a, base 36) for building ETags. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
