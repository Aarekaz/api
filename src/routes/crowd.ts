import { Hono } from "hono";
import type { Env } from "../types/env";
import { dateOnly } from "../utils/date";
import { limitBody } from "../middleware/body-limit";
import {
  apiTags,
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
// A visit is `{ "id": "<a few dozen characters>" }`. A body without a length
// that runs past this is cut off, and the visit falls back to network identity.
const MAX_BODY_BYTES = 8 * 1024;

// OpenAPI registrations (public — no security)
const TAG = "Crowd";
apiTags.push({
  name: TAG,
  description: `The visitor count behind the living-world site (aarekaz.me): \`tending\` is people there in the last hour, \
\`total\` all-time distinct visitors. Public and unauthenticated (the browser calls it), but nothing here is shown on anuragd.me.

**Read only.** Use GET /v1/crowd. Don't POST: a POST records a visit (one per visitor per day), so an agent posting \
would count itself as a person. Nothing to create, upload or publish here.`,
});
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/crowd",
  tags: [TAG],
  summary: "Read the living-world crowd (public)",
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/crowd",
  tags: [TAG],
  summary: "Record an anonymous visit and read the crowd (public)",
  description: "Body { id } (the browser's own stable id; only its hash is kept). For the site's visitors, not for agents.",
  responses: okResponses(genericObjectSchema),
});

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// tending = distinct visitors active in the last hour; total = all-time
// distinct, kept by migration 0054's trigger so it isn't counted per request.
// Before 0054 is applied the total is counted as it always was.
async function readCrowd(env: Env, now: number) {
  const tending = "(SELECT COUNT(DISTINCT visitor_hash) FROM crowd_visits WHERE ts > ?1)";
  const read = (total: string) => env.DB.prepare(`SELECT ${total} AS total, ${tending} AS tending`)
    .bind(now - HOUR_MS)
    .first<{ total: number | null; tending: number }>();
  const row = await read("(SELECT visitors FROM crowd_totals WHERE id = 1)").catch((error: unknown) => {
    if (!/no such table/i.test(String(error))) throw error;
    return read("(SELECT COUNT(DISTINCT visitor_hash) FROM crowd_visits)");
  });
  return { tending: row?.tending ?? 0, total: row?.total ?? 0 };
}

// Read without recording.
app.get("/", async (c) => {
  return c.json(await readCrowd(c.env, Date.now()));
});

// Record this visitor (one row per visitor per day), then return fresh counts.
app.post("/", limitBody(MAX_BODY_BYTES), async (c) => {
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
