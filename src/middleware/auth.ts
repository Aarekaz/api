import { Context, Next } from "hono";
import type { Env } from "../types/env";
import { isValidSession } from "../services/app-auth";
import { fail } from "../lib/http";
import { isSitePath, isSiteRead } from "../lib/site-reads";

// Paths that use their own token validation (e.g. presigned upload), plus the
// public crowd endpoint, which the living-world site calls anonymously.
const AUTH_SKIP_PATHS = [
  "/v1/photos/upload-presigned",
  "/v1/blog-images/upload-presigned",
  "/v1/crowd",
];

/**
 * Who may call what (docs/adr/0014-401-and-403.md). No credentials, or ones
 * this API doesn't know, is 401 with a Bearer challenge: sign in again. A
 * token it knows that may not do this (the website's token anywhere but the
 * website's reads) is 403: signing in again won't help.
 */
export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  // Skip auth for paths that handle their own token validation
  if (AUTH_SKIP_PATHS.some((p) => c.req.path === p)) {
    return next();
  }

  const env = c.env;

  if (!env.API_TOKEN) {
    return refuse(c, 500, "API token not configured");
  }

  const authHeader = c.req.header("authorization");
  if (!authHeader) {
    return refuse(c, 401, "Missing authorization header", "Bearer");
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return refuse(c, 401, "Invalid token", 'Bearer error="invalid_token"');
  }
  // Both comparisons always run, so the time taken doesn't say which token it was.
  const [owner, site] = await Promise.all([sameSecret(token, env.API_TOKEN), sameSecret(token, env.SITE_TOKEN)]);
  // The owner's API token: everything.
  if (owner) return next();
  // The website's token (optional): only the GETs the website makes.
  if (site) {
    // Published rows only: ?include_unpublished is for the owner's apps, never the site's token.
    if (isSiteRead(c.req.method, c.req.path) && c.req.query("include_unpublished") === undefined) return next();
    return refuse(c, 403, "This token can only read the website's data", 'Bearer error="insufficient_scope"');
  }
  // A device session from Sign in with GitHub in the apps.
  if (await isValidSession(env, token)) return next();
  return refuse(c, 401, "Invalid token", 'Bearer error="invalid_token"');
}

/**
 * A refusal in the error shape of the route asked for: website routes keep
 * their old body, `{ error: "…" }`, every other route has the one shape
 * (lib/http.ts). `challenge` is the WWW-Authenticate header (RFC 6750).
 */
function refuse(c: Context<{ Bindings: Env }>, status: 401 | 403 | 500, message: string, challenge?: string) {
  if (challenge) c.header("WWW-Authenticate", challenge);
  return isSitePath(c.req.path) ? c.json({ error: message }, status) : fail(c, status, message);
}

/**
 * Compares in constant time, so how long a wrong token takes says nothing
 * about the right one. Both sides are hashed first, so not even the length
 * shows.
 */
export async function sameSecret(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
