import type { Context } from "hono";
import { z } from "zod";
import type { ValidationResult } from "../types/common";
import { parseJson } from "../utils/json";
import { parseId } from "../utils/query";

/**
 * Replies for the routes the website reads and their writes (profile,
 * projects, posts, photos, shelf, settings, now, uses, skills, experience,
 * education, github, wakatime, location, finance, health data). They keep the
 * website's error shape, `{ "error": "message" }` with an optional `details`,
 * and the app's routes use lib/http.ts instead. docs/adr/0007-one-module-per-error-dialect.md.
 *
 * Unlike lib/http.ts these return a Response for the handler to send rather
 * than throwing, so a handler reads top to bottom with its early returns, as
 * every website route always has. The exact bytes (including the validation
 * replies' `charset=utf-8`) are pinned by __tests__/routes/website-crud.test.ts.
 */

type AnyContext = Context<any, any, any>;

/** `{ error, details? }` built by hand (not c.json), as the validation replies always were. */
function errorResponse(message: string, status: number, details?: unknown): Response {
  const body = details ? { error: message, details } : { error: message };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** A value checked against a schema; a mismatch is "Validation error" with Zod's `flatten()`. */
export function validateBody<T extends z.ZodTypeAny>(schema: T, body: unknown): ValidationResult<z.infer<T>> {
  const result = schema.safeParse(body);
  if (!result.success) return { ok: false, response: errorResponse("Validation error", 400, result.error.flatten()) };
  return { ok: true, data: result.data };
}

/** Query parameters checked against a schema; a mismatch is "Invalid query parameters". */
export function validateQuery<T extends z.ZodTypeAny>(schema: T, query: unknown): ValidationResult<z.infer<T>> {
  const result = schema.safeParse(query);
  if (!result.success) return { ok: false, response: errorResponse("Invalid query parameters", 400, result.error.flatten()) };
  return { ok: true, data: result.data };
}

/** The JSON body checked against `schema`: unreadable JSON is `{ error: "Invalid JSON" }`, a mismatch as validateBody. */
export async function readBody<T extends z.ZodTypeAny>(c: AnyContext, schema: T): Promise<ValidationResult<z.infer<T>>> {
  const body = await parseJson(c.req.raw);
  if (body === null) return { ok: false, response: c.json({ error: "Invalid JSON" }, 400) };
  return validateBody(schema, body);
}

/** `:id` as a positive integer, or null (then reply with `badId`). */
export const idParam = (c: AnyContext, name = "id"): number | null => parseId(c.req.param(name) ?? "");

/** `{ error: "Invalid id" }`, 400. */
export const badId = (c: AnyContext) => c.json({ error: "Invalid id" }, 400);

/** `{ error: "<what> not found" }`, 404. */
export const notFound = (c: AnyContext, what: string) => c.json({ error: `${what} not found` }, 404);
