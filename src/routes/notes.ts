import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeNote } from "../utils/normalizers";
import { noteSchema } from "../schemas/content";
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
  path: "/v1/notes",
  summary: "List notes",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/notes",
  summary: "Create note",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(noteSchema) },
  responses: createdResponses(okCreatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM notes ORDER BY created_at DESC"
  ).all();
  const results = (rows.results ?? []).map((row) =>
    normalizeNote(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(noteSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO notes (title, body, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.title ?? null,
      validation.data.body ?? null,
      mapJsonField(validation.data.tags),
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

export default app;
