import { Hono } from "hono";
import type { Env } from "../types/env";
import { fileExtensionForContentType } from "../utils/content-type";
import {
  openApiRegistry,
  openApiResponse,
  okResponses,
  errorResponses,
  errorSchema,
  authSecurity,
  imageUploadSchema,
  photoUploadResponseSchema,
  presignResponseSchema,
  presignHeadersSchema,
  uploadTokenHeadersSchema,
} from "../schemas/openapi";
import { signUploadToken, verifyUploadToken } from "../services/upload-token";

const app = new Hono<{ Bindings: Env }>();

// Blog images are embedded in markdown — no DB metadata, just R2 storage.
// Mirrors the photos presign/upload-presigned/upload flow but with:
//   - key prefix: blog/ (keeps photography and blog-image lifecycles separate)
//   - 5MB direct-upload cap (screenshots, not DSLR raws)
//   - restricted content types (no SVG — XSS risk when rendered as <img>)

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

const MAX_DIRECT_UPLOAD = 5 * 1024 * 1024;

/* ── OpenAPI ─────────────────────────────────────────────────────────── */

const blogImageBody = {
  description: "PNG, JPEG or WebP image",
  content: {
    "image/png": { schema: imageUploadSchema },
    "image/jpeg": { schema: imageUploadSchema },
    "image/webp": { schema: imageUploadSchema },
  },
};

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/blog-images/presign",
  summary: "Create a presigned blog image upload token",
  description: "X-Content-Type defaults to image/png. The token is valid for 5 minutes.",
  security: authSecurity,
  request: { headers: presignHeadersSchema },
  responses: {
    ...okResponses(presignResponseSchema),
    415: openApiResponse(errorSchema, "Unsupported content type"),
  },
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/blog-images/upload-presigned",
  summary: "Upload a blog image with a presigned token",
  description: "Authenticated by the X-Upload-Token header instead of the bearer token.",
  request: { headers: uploadTokenHeadersSchema, body: blogImageBody },
  responses: {
    201: openApiResponse(photoUploadResponseSchema, "Created"),
    400: openApiResponse(errorSchema, "Missing body"),
    401: openApiResponse(errorSchema, "Missing upload token"),
    403: openApiResponse(errorSchema, "Invalid or expired upload token"),
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/blog-images/upload",
  summary: "Upload a blog image to R2 (up to 5 MB)",
  security: authSecurity,
  request: { body: blogImageBody },
  responses: {
    201: openApiResponse(photoUploadResponseSchema, "Created"),
    ...errorResponses,
    413: openApiResponse(errorSchema, "File too large"),
    415: openApiResponse(errorSchema, "Unsupported content type"),
  },
});

/* ── Routes ──────────────────────────────────────────────────────────── */

app.post("/presign", async (c) => {
  const contentType = (c.req.header("x-content-type") || "image/png").toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    return c.json({ error: "Unsupported content type" }, 415);
  }

  const ext = fileExtensionForContentType(contentType);
  const key = `blog/${crypto.randomUUID()}.${ext}`;

  const uploadToken = await signUploadToken(key, contentType, c.env.API_TOKEN);
  const apiBase = c.env.API_BASE_URL?.replace(/\/$/, "") || "https://api.anuragd.me";

  return c.json({
    ok: true,
    key,
    uploadToken,
    uploadUrl: `${apiBase}/v1/blog-images/upload-presigned`,
    expiresIn: 300,
  });
});

app.put("/upload-presigned", async (c) => {
  const token = c.req.header("x-upload-token");
  if (!token) {
    return c.json({ error: "Missing upload token" }, 401);
  }

  const claim = await verifyUploadToken(token, c.env.API_TOKEN, "blog/");
  if (!claim) {
    return c.json({ error: "Invalid or expired upload token" }, 403);
  }

  if (!c.req.raw.body) {
    return c.json({ error: "Missing body" }, 400);
  }

  await c.env.R2_BUCKET.put(claim.key, c.req.raw.body, {
    httpMetadata: { contentType: claim.contentType },
  });

  const baseUrl = c.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
  const url = baseUrl ? `${baseUrl}/${claim.key}` : claim.key;

  return c.json(
    { ok: true, key: claim.key, url, content_type: claim.contentType },
    201,
  );
});

app.post("/upload", async (c) => {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    return c.json({ error: "Unsupported content type" }, 415);
  }

  const contentLength = c.req.header("content-length");
  if (contentLength && Number(contentLength) > MAX_DIRECT_UPLOAD) {
    return c.json({ error: "File too large" }, 413);
  }

  if (!c.req.raw.body) {
    return c.json({ error: "Missing body" }, 400);
  }

  const ext = fileExtensionForContentType(contentType);
  const key = `blog/${crypto.randomUUID()}.${ext}`;

  await c.env.R2_BUCKET.put(key, c.req.raw.body, {
    httpMetadata: { contentType },
  });

  const baseUrl = c.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
  const url = baseUrl ? `${baseUrl}/${key}` : key;

  return c.json({ ok: true, key, url, content_type: contentType }, 201);
});

export default app;
