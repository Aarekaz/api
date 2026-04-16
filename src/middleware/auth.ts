import { Context, Next } from "hono";
import type { Env } from "../types/env";

// Paths that use their own token validation (e.g. presigned upload)
const AUTH_SKIP_PATHS = ["/v1/photos/upload-presigned"];

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
  if (scheme !== "Bearer" || token !== env.API_TOKEN) {
    return c.json({ error: "Invalid token" }, 403);
  }

  await next();
}
