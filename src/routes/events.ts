import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeEvent } from "../utils/normalizers";
import { eventSchema } from "../schemas/content";
import {
  openApiRegistry,
  genericArraySchema,
  okOccurredSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/events",
  summary: "List events",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/events",
  summary: "Create event",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(eventSchema) },
  responses: createdResponses(okOccurredSchema),
});

// Route handlers
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM events ORDER BY occurred_at DESC"
  ).all();
  const results = (rows.results ?? []).map((row) =>
    normalizeEvent(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(eventSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const occurredAt = validation.data.occurred_at ?? nowIso();
  await c.env.DB.prepare(
    `INSERT INTO events (type, payload_json, occurred_at)
     VALUES (?, ?, ?)`
  )
    .bind(
      validation.data.type,
      mapJsonField(validation.data.payload),
      occurredAt
    )
    .run();

  return c.json({ ok: true, occurred_at: occurredAt }, 201);
});

export default app;
