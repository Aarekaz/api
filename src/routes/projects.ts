import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeProject } from "../utils/normalizers";
import { projectSchema } from "../schemas/content";
import {
  openApiRegistry,
  genericArraySchema,
  okCreatedSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  openApiResponseWithExample,
  authSecurity,
  errorResponses,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/projects",
  summary: "List projects",
  security: authSecurity,
  responses: {
    200: openApiResponseWithExample(genericArraySchema, "OK", [
      {
        id: 1,
        title: "Personal API",
        description: "Cloudflare Worker + D1.",
        links: ["https://api.example.com", "https://github.com/user/repo"],
        tags: ["cloudflare", "typescript"],
        status: "active",
        created_at: "2025-01-05T12:34:56.000Z",
        updated_at: "2025-01-05T12:34:56.000Z",
      },
    ]),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/projects",
  summary: "Create project",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(projectSchema) },
  responses: createdResponses(okCreatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM projects ORDER BY created_at DESC"
  ).all();
  const results = (rows.results ?? []).map((row) =>
    normalizeProject(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(projectSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO projects (title, description, links_json, tags_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.title,
      validation.data.description ?? null,
      mapJsonField(validation.data.links),
      mapJsonField(validation.data.tags),
      validation.data.status ?? null,
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

export default app;
