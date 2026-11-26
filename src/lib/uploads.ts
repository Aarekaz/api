import type { Context } from "hono";
import type { Env } from "../types/env";
import { fileExtensionForContentType } from "../utils/content-type";
import {
  UPLOAD_KINDS,
  imageType,
  refundUploadToken,
  signUploadToken,
  sizeProblem,
  spendUploadToken,
  uploadSecret,
  verifyUploadToken,
  type UploadKind,
} from "../services/upload-token";

/**
 * The three upload handlers photos and blog images share: presign, the
 * presigned PUT and the direct POST. Both routes are the website's, so the
 * replies keep its error shape (`{ "error": "…" }`, ADR 0007). What differs by
 * kind (prefix, types, caps) is in UPLOAD_KINDS.
 */

type Ctx = Context<{ Bindings: Env }>;

const publicUrl = (env: Env, key: string) => {
  const base = env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
  return base ? `${base}/${key}` : key;
};

const stored = (c: Ctx, key: string, contentType: string) =>
  c.json({ ok: true, key, url: publicUrl(c.env, key), content_type: contentType }, 201);

const newKey = (kind: UploadKind, contentType: string) =>
  `${UPLOAD_KINDS[kind].prefix}${crypto.randomUUID()}.${fileExtensionForContentType(contentType)}`;

/** POST …/presign (X-Content-Type): a token for one PUT of one file of that type. */
export const presign = (kind: UploadKind) => async (c: Ctx) => {
  const spec = UPLOAD_KINDS[kind];
  const contentType = imageType(c.req.header("x-content-type") || spec.defaultType, spec.types);
  if (!contentType) return c.json({ error: "Unsupported content type" }, 415);
  const key = newKey(kind, contentType);
  const uploadToken = await signUploadToken(kind, key, contentType, uploadSecret(c.env));
  const apiBase = c.env.API_BASE_URL?.replace(/\/$/, "") || "https://api.anuragd.me";
  return c.json({ ok: true, key, uploadToken, uploadUrl: `${apiBase}${spec.route}/upload-presigned`, expiresIn: 300 });
};

/** PUT …/upload-presigned (X-Upload-Token): stores the body under the token's key, once. */
export const presignedPut = (kind: UploadKind) => async (c: Ctx) => {
  const token = c.req.header("x-upload-token");
  if (!token) return c.json({ error: "Missing upload token" }, 401);
  const claim = await verifyUploadToken(token, uploadSecret(c.env), kind);
  if (!claim) return c.json({ error: "Invalid or expired upload token" }, 403);
  const problem = sizeProblem(c.req.header("content-length"), UPLOAD_KINDS[kind].presignedMax);
  if (problem) return c.json({ error: problem.message }, problem.status);
  if (!c.req.raw.body) return c.json({ error: "Missing body" }, 400);
  if (!(await spendUploadToken(c.env, claim))) return c.json({ error: "Upload token already used" }, 403);
  try {
    await c.env.R2_BUCKET.put(claim.key, c.req.raw.body, { httpMetadata: { contentType: claim.contentType } });
  } catch (error) {
    // Nothing was stored, so the same token may try again.
    await refundUploadToken(c.env, claim);
    throw error;
  }
  return stored(c, claim.key, claim.contentType);
};

/** POST …/upload (bearer token): the body itself, up to the kind's direct cap. */
export const directUpload = (kind: UploadKind) => async (c: Ctx) => {
  const spec = UPLOAD_KINDS[kind];
  const contentType = imageType(c.req.header("content-type"), spec.types);
  if (!contentType) return c.json({ error: "Unsupported content type" }, 415);
  const problem = sizeProblem(c.req.header("content-length"), spec.directMax);
  if (problem) return c.json({ error: problem.message }, problem.status);
  if (!c.req.raw.body) return c.json({ error: "Missing body" }, 400);
  const key = newKey(kind, contentType);
  await c.env.R2_BUCKET.put(key, c.req.raw.body, { httpMetadata: { contentType } });
  return stored(c, key, contentType);
};
