import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeProfile } from "../utils/normalizers";
import { profileSchema } from "../schemas/profile";
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
  path: "/v1/profile",
  summary: "Fetch profile",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/profile",
  summary: "Update profile",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(profileSchema) },
  responses: okResponses(okUpdatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM profile WHERE id = 1").all();
  return c.json(
    row.results[0] ? normalizeProfile(row.results[0] as JsonRecord) : {}
  );
});

app.put("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(profileSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO profile (id, name, bio, handles_json, contact_json, timezone, avatar_url, location, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       bio = excluded.bio,
       handles_json = excluded.handles_json,
       contact_json = excluded.contact_json,
       timezone = excluded.timezone,
       avatar_url = excluded.avatar_url,
       location = excluded.location,
       updated_at = excluded.updated_at`
  )
    .bind(
      validation.data.name ?? null,
      validation.data.bio ?? null,
      mapJsonField(validation.data.handles),
      mapJsonField(validation.data.contact),
      validation.data.timezone ?? null,
      validation.data.avatar_url ?? null,
      validation.data.location ?? null,
      updatedAt
    )
    .run();

  return c.json({ ok: true, updated_at: updatedAt });
});

export default app;
