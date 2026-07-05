import { Hono } from "hono";
import type { Env } from "../types/env";
import { dateOnly } from "../utils/date";
import {
  openApiRegistry,
  genericObjectSchema,
  okResponses,
} from "../schemas/openapi";

// The crowd behind the living-world site (aarekaz.me). PUBLIC and unauthenticated
// — the browser calls it directly — so it is listed in AUTH_SKIP_PATHS and given
// CORS headers in index.ts. Visits are deduped per visitor per day server-side,
// so the count reflects real people, not refreshes.

const app = new Hono<{ Bindings: Env }>();

const HOUR_MS = 60 * 60 * 1000;

// OpenAPI registrations (public — no security)
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/crowd",
  summary: "Read the living-world crowd (public)",
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/crowd",
  summary: "Record an anonymous visit and read the crowd (public)",
  responses: okResponses(genericObjectSchema),
});

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// tending = distinct visitors active in the last hour; total = all-time distinct.
async function readCrowd(env: Env, now: number) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(DISTINCT visitor_hash) FROM crowd_visits) AS total,
       (SELECT COUNT(DISTINCT visitor_hash) FROM crowd_visits WHERE ts > ?1) AS tending`
  )
    .bind(now - HOUR_MS)
    .first<{ total: number; tending: number }>();
  return { tending: row?.tending ?? 0, total: row?.total ?? 0 };
}

// Read without recording.
app.get("/", async (c) => {
  return c.json(await readCrowd(c.env, Date.now()));
});

// Record this visitor (one row per visitor per day), then return fresh counts.
app.post("/", async (c) => {
  const now = Date.now();
  const day = dateOnly(new Date(now));

  // Prefer the client's stable id; fall back to network identity if absent. The
  // raw id is never stored — only its hash.
  let id = "";
  try {
    const body = (await c.req.json()) as { id?: unknown };
    if (typeof body?.id === "string") id = body.id;
  } catch {
    // missing or invalid body — fall through to network-derived identity
  }
  if (!id) {
    const ip = c.req.header("cf-connecting-ip") ?? "";
    const ua = c.req.header("user-agent") ?? "";
    id = `${ip}:${ua}`;
  }

  const visitorHash = await sha256Hex(id);

  await c.env.DB.prepare(
    `INSERT INTO crowd_visits (visitor_hash, day, ts) VALUES (?1, ?2, ?3)
     ON CONFLICT(visitor_hash, day) DO UPDATE SET ts = ?3`
  )
    .bind(visitorHash, day, now)
    .run();

  return c.json(await readCrowd(c.env, now));
});

export default app;
