import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import { educationSchema } from "../schemas/profile";
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
  path: "/v1/education",
  summary: "List education",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/education",
  summary: "Create education",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(educationSchema) },
  responses: createdResponses(okCreatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM education ORDER BY start_date DESC"
  ).all();
  return c.json(rows.results ?? []);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(educationSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO education (institution, degree, field, start_date, end_date, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.institution,
      validation.data.degree ?? null,
      validation.data.field ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      validation.data.description ?? null,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

export default app;
