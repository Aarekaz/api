import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizePhoto } from "../utils/normalizers";
import { fileExtensionForContentType } from "../utils/response";
import { photoSchema } from "../schemas/content";
import {
  openApiRegistry,
  genericArraySchema,
  okCreatedSchema,
  photoUploadResponseSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  openApiResponse,
  authSecurity,
  errorResponses,
  imageUploadSchema,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/photos",
  summary: "List photos",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos",
  summary: "Create photo",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(photoSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos/upload",
  summary: "Upload photo to R2",
  security: authSecurity,
  request: {
    body: {
      description: "Image file",
      content: {
        "image/*": { schema: imageUploadSchema },
      },
    },
  },
  responses: {
    201: openApiResponse(photoUploadResponseSchema, "Created"),
    ...errorResponses,
  },
});

// Route handlers
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM photos ORDER BY shot_at DESC, created_at DESC"
  ).all();
  const results = (rows.results ?? []).map((row) =>
    normalizePhoto(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(photoSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO photos (title, description, url, thumb_url, width, height, shot_at, camera, lens, settings, location, tags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.title ?? null,
      validation.data.description ?? null,
      validation.data.url,
      validation.data.thumb_url ?? null,
      validation.data.width ?? null,
      validation.data.height ?? null,
      validation.data.shot_at ?? null,
      validation.data.camera ?? null,
      validation.data.lens ?? null,
      validation.data.settings ?? null,
      validation.data.location ?? null,
      mapJsonField(validation.data.tags),
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

app.post("/upload", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "Unsupported content type" }, 415);
  }

  const contentLength = c.req.header("content-length");
  if (contentLength && Number(contentLength) > 10 * 1024 * 1024) {
    return c.json({ error: "File too large" }, 413);
  }

  if (!c.req.raw.body) {
    return c.json({ error: "Missing body" }, 400);
  }

  const ext = fileExtensionForContentType(contentType);
  const key = `photos/${crypto.randomUUID()}.${ext}`;

  await c.env.R2_BUCKET.put(key, c.req.raw.body, {
    httpMetadata: { contentType },
  });

  const baseUrl = c.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
  const url = baseUrl ? `${baseUrl}/${key}` : key;

  return c.json(
    {
      ok: true,
      key,
      url,
      content_type: contentType,
    },
    201
  );
});

export default app;
