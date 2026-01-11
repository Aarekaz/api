import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeSkill } from "../utils/normalizers";
import { skillSchema } from "../schemas/profile";
import {
  openApiRegistry,
  genericArraySchema,
  okCreatedSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/skills",
  summary: "List skills",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/skills",
  summary: "Create skill",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(skillSchema) },
  responses: createdResponses(okCreatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM skills ORDER BY category ASC"
  ).all();
  const results = (rows.results ?? []).map((row) =>
    normalizeSkill(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(skillSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO skills (category, items_json, created_at)
     VALUES (?, ?, ?)`
  )
    .bind(
      validation.data.category,
      mapJsonField(validation.data.items),
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

export default app;
