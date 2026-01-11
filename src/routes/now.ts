import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { nowSchema } from "../schemas/profile";
import {
  openApiRegistry,
  genericObjectSchema,
  okUpdatedSchema,
  openApiJsonRequestBody,
  okResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/now",
  summary: "Fetch current status",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/now",
  summary: "Update current status",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(nowSchema) },
  responses: okResponses(okUpdatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM now_state WHERE id = 1").all();
  return c.json(row.results[0] ?? {});
});

app.put("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(nowSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO now_state (id, focus, status, availability, mood, current_song, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       focus = excluded.focus,
       status = excluded.status,
       availability = excluded.availability,
       mood = excluded.mood,
       current_song = excluded.current_song,
       updated_at = excluded.updated_at`
  )
    .bind(
      validation.data.focus ?? null,
      validation.data.status ?? null,
      validation.data.availability ?? null,
      validation.data.mood ?? null,
      validation.data.current_song ?? null,
      updatedAt
    )
    .run();

  return c.json({ ok: true, updated_at: updatedAt });
});

export default app;
