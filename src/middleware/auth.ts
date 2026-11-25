import { Context, Next } from "hono";
import type { Env } from "../types/env";
import { isValidSession } from "../services/app-auth";

// Paths that use their own token validation (e.g. presigned upload), plus the
// public crowd endpoint, which the living-world site calls anonymously.
const AUTH_SKIP_PATHS = [
  "/v1/photos/upload-presigned",
  "/v1/blog-images/upload-presigned",
  "/v1/crowd",
];

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  // Skip auth for paths that handle their own token validation
  if (AUTH_SKIP_PATHS.some((p) => c.req.path === p)) {
    return next();
  }

  const env = c.env;

  if (!env.API_TOKEN) {
    return c.json({ error: "API token not configured" }, 500);
  }

  const authHeader = c.req.header("authorization");
  if (!authHeader) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return c.json({ error: "Invalid token" }, 403);
  }
  // The owner's API token, or a device session from Sign in with GitHub in the apps.
  if (!sameSecret(token, env.API_TOKEN) && !(await isValidSession(env, token))) {
    return c.json({ error: "Invalid token" }, 403);
  }

  await next();
}

/** Compares in constant time, so how long a wrong token takes says nothing about the right one. */
export function sameSecret(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}
