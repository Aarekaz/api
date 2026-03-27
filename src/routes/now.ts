import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { nowSchema } from "../schemas/profile";
import { normalizeNow } from "../utils/normalizers";
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
  return c.json(
    row.results[0] ? normalizeNow(row.results[0] as JsonRecord) : {}
  );
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
    `INSERT INTO now_state (id, focus, status, availability, mood, current_song, learning_json, projects_json, life_json, reading_goal, last_updated, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       focus = excluded.focus,
       status = excluded.status,
       availability = excluded.availability,
       mood = excluded.mood,
       current_song = excluded.current_song,
       learning_json = excluded.learning_json,
       projects_json = excluded.projects_json,
       life_json = excluded.life_json,
       reading_goal = excluded.reading_goal,
       last_updated = excluded.last_updated,
       updated_at = excluded.updated_at`
  )
    .bind(
      validation.data.focus ?? null,
      validation.data.status ?? null,
      validation.data.availability ?? null,
      validation.data.mood ?? null,
      validation.data.current_song ?? null,
      mapJsonField(validation.data.learning),
      mapJsonField(validation.data.projects),
      mapJsonField(validation.data.life),
      validation.data.reading_goal ?? null,
      validation.data.last_updated ?? null,
      updatedAt
    )
    .run();

  return c.json({ ok: true, updated_at: updatedAt });
});

export default app;
