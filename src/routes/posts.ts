import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizePost } from "../utils/normalizers";
import { postSchema } from "../schemas/content";
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
  path: "/v1/posts",
  summary: "List posts",
  security: authSecurity,
  responses: {
    200: openApiResponseWithExample(genericArraySchema, "OK", [
      {
        id: 1,
        slug: "hello-world",
        title: "Hello World",
        summary: "My first post",
        content: "Lorem ipsum...",
        tags: ["meta"],
        published_at: "2025-01-01T00:00:00.000Z",
        pinned: false,
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    ]),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/posts",
  summary: "Create post",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(postSchema) },
  responses: createdResponses(okCreatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM posts ORDER BY published_at DESC, updated_at DESC"
  ).all();
  const results = (rows.results ?? []).map((row) =>
    normalizePost(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(postSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO posts (slug, title, summary, content, tags_json, published_at, pinned, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.slug,
      validation.data.title,
      validation.data.summary ?? null,
      validation.data.content ?? null,
      mapJsonField(validation.data.tags),
      validation.data.published_at ?? null,
      validation.data.pinned ? 1 : 0,
      updatedAt
    )
    .run();

  return c.json({ ok: true, updated_at: updatedAt }, 201);
});

export default app;
