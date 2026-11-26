import type { Context } from "hono";
import type { Env } from "../types/env";
import { fail } from "./http";
import { ulid } from "../services/documents-core";

// Photos that belong to private things (journal entries, notes): kept in the
// private bucket, which has no public address, under an unguessable name, and
// read back only through an authenticated route. One upload and one read for
// both, so their limits and errors never drift apart.

export const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp" };
export const MAX_PHOTO = 15 * 1024 * 1024;
/** A stored photo's file name (the part after its prefix). */
export const PHOTO_NAME = /^[0-9A-Za-z-]{20,80}\.(jpg|png|heic|webp)$/;

type AppContext = Context<{ Bindings: Env }>;

/**
 * Reads a raw image body and stores it as `<prefix>/<name>` in `bucket`.
 * Answers the error itself (415, 413, 400) or hands back the stored object.
 */
export async function receivePhoto(c: AppContext, prefix: string, bucket: R2Bucket):
  Promise<Response | { ref: string; name: string; content_type: string; size: number }> {
  const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const ext = PHOTO_TYPES[type];
  if (!ext) return fail(c, 415, "Send a JPEG, PNG, HEIC or WebP image", { code: "invalid" });
  const length = Number(c.req.header("content-length"));
  if (length > MAX_PHOTO) return fail(c, 413, "Photos can be up to 15 MB");
  const data = await c.req.arrayBuffer();
  if (!data.byteLength) return fail(c, 400, "The image is empty");
  if (data.byteLength > MAX_PHOTO) return fail(c, 413, "Photos can be up to 15 MB");
  const name = `${ulid()}-${crypto.randomUUID()}.${ext}`;
  const ref = `${prefix}/${name}`;
  await bucket.put(ref, data, { httpMetadata: { contentType: type, cacheControl: "private, max-age=31536000, immutable" } });
  return { ref, name, content_type: type, size: data.byteLength };
}

/** The stored image, for the signed-in app only (never cached by a shared cache). */
export function photoResponse(object: R2ObjectBody): Response {
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
