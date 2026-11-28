import type { Env } from "../types/env";
import { photoFileName, privatePhotoUrl } from "./photo-privacy";

// A small copy of each Photography upload, for the apps' grids (the originals
// run to 3200 px). Made with the Cloudflare Images binding (`IMAGES`), which
// is off until it is added to wrangler.toml; without it uploads go on as
// before and no thumbnail is made.
//
// The thumbnail sits beside its original, in the same bucket and under the
// same name with `-thumb.webp`, so photo-privacy.ts moves it like any other
// photo file: a private photo's thumbnail is private too.

export const THUMB_WIDTH = 800;
const SUFFIX = "-thumb.webp";

/** `photos/<uuid>.jpg` → `photos/<uuid>-thumb.webp`. */
export const thumbKeyFor = (key: string) => key.replace(/\.[A-Za-z0-9]+$/, "") + SUFFIX;

/**
 * Makes and stores the thumbnail of `key` (already in `bucket`). Answers its
 * key, or null when there is no Images binding or the image can't be read.
 * A failure never fails the upload.
 */
export async function makeThumb(env: Env, bucket: R2Bucket, key: string): Promise<string | null> {
  if (!env.IMAGES) return null;
  try {
    const original = await bucket.get(key);
    if (!original) return null;
    const result = await env.IMAGES.input(original.body)
      .transform({ width: THUMB_WIDTH, fit: "scale-down" })
      .output({ format: "image/webp", quality: 80 });
    const thumbKey = thumbKeyFor(key);
    await bucket.put(thumbKey, await result.response().arrayBuffer(), { httpMetadata: { contentType: "image/webp" } });
    return thumbKey;
  } catch (error) {
    console.error(`photo thumbnail failed (${key})`, error);
    return null;
  }
}

/** The bucket holding `key`: the private one first (where originals live), else the public one. */
async function bucketWith(env: Env, key: string): Promise<R2Bucket | null> {
  if (env.R2_PRIVATE && (await env.R2_PRIVATE.head(key))) return env.R2_PRIVATE;
  if (await env.R2_BUCKET.head(key)) return env.R2_BUCKET;
  return null;
}

/**
 * The thumbnail address for a photo row whose `url` is one of ours, making the
 * thumbnail when `make` is set and it isn't there yet. The address is the
 * private route; the caller then runs applyPhotoVisibility, which copies the
 * file to the public bucket only when the photo is published. Null without the
 * binding or a readable file.
 */
export async function ensureThumb(env: Env, url: unknown, make = true): Promise<string | null> {
  if (!env.IMAGES) return null;
  const name = photoFileName(env, url);
  if (!name || name.endsWith(SUFFIX)) return null;
  const key = `photos/${name}`;
  const thumbKey = thumbKeyFor(key);
  const thumbName = thumbKey.slice("photos/".length);
  if (await bucketWith(env, thumbKey)) return privatePhotoUrl(env, thumbName);
  if (!make) return null;
  const bucket = await bucketWith(env, key);
  if (!bucket) return null;
  return (await makeThumb(env, bucket, key)) ? privatePhotoUrl(env, thumbName) : null;
}
