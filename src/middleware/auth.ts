import { Context, Next } from "hono";
import type { Env } from "../types/env";

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
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
