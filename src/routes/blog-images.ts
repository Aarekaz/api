import { Hono } from "hono";
import type { Env } from "../types/env";
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
import { directUpload, presign, presignedPut } from "../lib/uploads";

const app = new Hono<{ Bindings: Env }>();

// Blog images are embedded in markdown — no DB metadata, just R2 storage.
// The same presign / upload-presigned / upload flow as photos (lib/uploads.ts),
// with its own key prefix (blog/), smaller caps and PNG, JPEG or WebP only
// (UPLOAD_KINDS in services/upload-token.ts).

/* ── OpenAPI ─────────────────────────────────────────────────────────── */

// These paths share the Posts tag; its guide is pushed by routes/posts.ts, not here.
const TAG = "Posts";
const PUBLIC_AT_ONCE = "Stored in the public bucket: the url works for anyone straight away, before any post is published. "
  + "A note's photos go to POST /v1/documents/photos instead (private).";

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
  tags: [TAG],
  summary: "Create a presigned blog image upload token",
  description: "X-Content-Type defaults to image/png. The token is valid for 5 minutes and stores one file (up to 25 MB). "
    + PUBLIC_AT_ONCE,
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
  tags: [TAG],
  summary: "Upload a blog image with a presigned token",
  description: "Authenticated by the X-Upload-Token header instead of the bearer token.",
  request: { headers: uploadTokenHeadersSchema, body: blogImageBody },
  responses: {
    201: openApiResponse(photoUploadResponseSchema, "Created"),
    400: openApiResponse(errorSchema, "Missing body"),
    401: openApiResponse(errorSchema, "Missing upload token"),
    403: openApiResponse(errorSchema, "Invalid, expired or already used upload token (each token stores one file)"),
    411: openApiResponse(errorSchema, "Length required (no Content-Length)"),
    413: openApiResponse(errorSchema, "File too large"),
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/blog-images/upload",
  tags: [TAG],
  summary: "Upload a blog image to R2 (up to 5 MB)",
  description: "The raw bytes as the body, with Content-Type image/png, image/jpeg or image/webp. " + PUBLIC_AT_ONCE,
  security: authSecurity,
  request: { body: blogImageBody },
  responses: {
    201: openApiResponse(photoUploadResponseSchema, "Created"),
    ...errorResponses,
    411: openApiResponse(errorSchema, "Length required (no Content-Length)"),
    413: openApiResponse(errorSchema, "File too large"),
    415: openApiResponse(errorSchema, "Unsupported content type"),
  },
});

/* ── Routes ──────────────────────────────────────────────────────────── */

app.post("/presign", presign("blog"));
app.put("/upload-presigned", presignedPut("blog"));
app.post("/upload", directUpload("blog"));

export default app;
