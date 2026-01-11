import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { normalizeStatusSnapshot } from "../utils/normalizers";
import { fetchLanyardStatus, saveStatusSnapshot } from "../services/lanyard";
import {
  openApiRegistry,
  genericObjectSchema,
  statusRefreshResponseSchema,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/status",
  summary: "Get latest status",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/status/refresh",
  summary: "Refresh status from Lanyard",
  security: authSecurity,
  responses: createdResponses(statusRefreshResponseSchema),
});

// Route handlers
app.get("/", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT * FROM status_snapshots ORDER BY created_at DESC LIMIT 1"
  ).all();
  return c.json(
    row.results[0]
      ? normalizeStatusSnapshot(row.results[0] as JsonRecord)
      : {}
  );
});

app.post("/refresh", async (c) => {
  const data = await fetchLanyardStatus(c.env);
  if (!data) {
    return c.json({ error: "Failed to fetch status" }, 502);
  }

  const createdAt = await saveStatusSnapshot(c.env, data);
  const activity = Array.isArray(data.activities) ? data.activities[0] : null;

  return c.json(
    {
      ok: true,
      created_at: createdAt,
      discord_status: data.discord_status ?? null,
      activity,
      spotify: data.spotify ?? null,
    },
    201
  );
});

export default app;
