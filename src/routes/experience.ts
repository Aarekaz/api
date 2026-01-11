import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import { experienceSchema } from "../schemas/profile";
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
  path: "/v1/experience",
  summary: "List experience",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/experience",
  summary: "Create experience",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(experienceSchema) },
  responses: createdResponses(okCreatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM experience ORDER BY start_date DESC"
  ).all();
  return c.json(rows.results ?? []);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(experienceSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO experience (company, role, location, start_date, end_date, employment_type, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.company,
      validation.data.role,
      validation.data.location ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      validation.data.employment_type ?? null,
      validation.data.description ?? null,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

export default app;
