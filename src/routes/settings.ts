import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeSettings } from "../utils/normalizers";
import { settingsSchema } from "../schemas/profile";
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
  path: "/v1/settings",
  summary: "Fetch settings",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/settings",
  summary: "Update settings",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(settingsSchema) },
  responses: okResponses(okUpdatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM settings WHERE id = 1").all();
  return c.json(
    row.results[0] ? normalizeSettings(row.results[0] as JsonRecord) : {}
  );
});

app.put("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(settingsSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO settings (id, public_fields_json, theme, flags_json, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       public_fields_json = excluded.public_fields_json,
       theme = excluded.theme,
       flags_json = excluded.flags_json,
       updated_at = excluded.updated_at`
  )
    .bind(
      mapJsonField(validation.data.public_fields),
      validation.data.theme ?? null,
      mapJsonField(validation.data.flags),
      updatedAt
    )
    .run();

  return c.json({ ok: true, updated_at: updatedAt });
});

export default app;
