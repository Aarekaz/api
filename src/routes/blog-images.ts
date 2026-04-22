import { Hono } from "hono";
import type { Env } from "../types/env";
import { fileExtensionForContentType } from "../utils/response";

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

/* ── Presigned upload HMAC helpers (identical pattern to photos.ts) ──── */

async function signUploadToken(
  key: string,
  contentType: string,
  secret: string,
): Promise<string> {
  const payload = JSON.stringify({
    key,
    contentType,
    exp: Date.now() + 5 * 60 * 1000,
  });
  const enc = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(payload));
  const sigHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return btoa(payload) + "." + sigHex;
}

async function verifyUploadToken(
  token: string,
  secret: string,
): Promise<{ key: string; contentType: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payload = atob(parts[0]);
  const sigHex = parts[1];
  const enc = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const sigBytes = new Uint8Array(sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const valid = await crypto.subtle.verify("HMAC", hmacKey, sigBytes, enc.encode(payload));
  if (!valid) return null;
  const data = JSON.parse(payload);
  if (typeof data.exp !== "number" || Date.now() > data.exp) return null;
  return { key: data.key, contentType: data.contentType };
}

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

  const claim = await verifyUploadToken(token, c.env.API_TOKEN);
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
