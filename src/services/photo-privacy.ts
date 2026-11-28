import type { Env } from "../types/env";

// Photography's photos. An "Only you" photo is private: its file lives in the
// private bucket (no public address) as `photos/<name>`, and its row points at
// the authenticated route that serves it,
//   https://api.anuragd.me/v1/photos/file/<name>
// which only the signed-in apps can load. Putting it on anuragd.me copies the
// file to the public bucket under the same key and points the row there;
// taking it down removes the public copy and points the row back. The private
// file is the original and is never removed by either.
//
// Photos uploaded before this kept their only copy in the public bucket. The
// first time a hidden one is checked (`applyPhotoVisibility`), its file is
// copied to the private bucket before the public copy is removed.

export const PHOTO_FILE_ROUTE = "/v1/photos/file/";
const PREFIX = "photos/";
const FILE_NAME = /^[0-9A-Za-z-]{20,80}\.(jpg|png|heic|heif|webp|gif|avif)$/;
const PUBLIC_CACHE = "public, max-age=31536000, immutable";

const apiBase = (env: Env) => (env.API_BASE_URL || "https://api.anuragd.me").replace(/\/$/, "");
const publicBase = (env: Env) => (env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

/** Where the signed-in apps read a private photo. */
export const privatePhotoUrl = (env: Env, name: string) => `${apiBase(env)}${PHOTO_FILE_ROUTE}${name}`;
/** Where anyone reads a published photo. */
export const publicPhotoUrl = (env: Env, name: string) => `${publicBase(env)}/${PREFIX}${name}`;

/** The file name a photo URL points at (public or private address), or null for anything else. */
export function photoFileName(env: Env, url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  const base = publicBase(env);
  let name: string | null = null;
  if (base && url.startsWith(`${base}/${PREFIX}`)) name = url.slice(base.length + 1 + PREFIX.length);
  else {
    const at = url.indexOf(PHOTO_FILE_ROUTE);
    if (at >= 0 && (url.startsWith("/") || url.startsWith(apiBase(env)))) name = url.slice(at + PHOTO_FILE_ROUTE.length);
  }
  return name && FILE_NAME.test(name) ? name : null;
}

/** A name the private route may serve. */
export const isPhotoFileName = (name: string) => FILE_NAME.test(name);

async function copy(from: R2Bucket, to: R2Bucket, key: string, cacheControl?: string): Promise<boolean> {
  const object = await from.get(key);
  if (!object) return false;
  const contentType = object.httpMetadata?.contentType ?? "image/jpeg";
  await to.put(key, await object.arrayBuffer(), { httpMetadata: cacheControl ? { contentType, cacheControl } : { contentType } });
  return true;
}

/** Where one URL should point for this visibility, moving its file as needed. Unchanged when it can't be moved. */
async function place(env: Env, url: unknown, published: boolean, id: number): Promise<unknown> {
  const name = photoFileName(env, url);
  const vault = env.R2_PRIVATE;
  if (!name || !vault) return url;
  const key = `${PREFIX}${name}`;
  if (published) {
    if (!(await env.R2_BUCKET.head(key)) && !(await copy(vault, env.R2_BUCKET, key, PUBLIC_CACHE))) return url;
    return publicPhotoUrl(env, name);
  }
  if (!(await vault.head(key)) && !(await copy(env.R2_BUCKET, vault, key))) return url;
  // Another published photo sharing the file keeps its public copy.
  const shared = await env.DB.prepare(
    "SELECT 1 FROM photos WHERE id != ? AND published = 1 AND (url = ? OR thumb_url = ?) LIMIT 1"
  ).bind(id, publicPhotoUrl(env, name), publicPhotoUrl(env, name)).first();
  if (!shared) await env.R2_BUCKET.delete(key);
  return privatePhotoUrl(env, name);
}

export type PhotoMove = { id: number; title: string | null; published: boolean; from: string | null; to: string | null };

/**
 * Puts one photo's files where its visibility says (private bucket when hidden,
 * public copy too when published) and its row's URLs to match. With `dryRun`,
 * only reports what would change. Answers the change, or null when none.
 */
export async function applyPhotoVisibility(env: Env, id: number, dryRun = false): Promise<PhotoMove | null> {
  const row = await env.DB.prepare("SELECT id, title, url, thumb_url, published FROM photos WHERE id = ?")
    .bind(id).first<{ id: number; title: string | null; url: string | null; thumb_url: string | null; published: number | null }>();
  if (!row) return null;
  const published = row.published !== 0;
  if (dryRun) {
    const name = photoFileName(env, row.url);
    if (!name || !env.R2_PRIVATE) return null;
    const want = published ? publicPhotoUrl(env, name) : privatePhotoUrl(env, name);
    return want === row.url ? null : { id: row.id, title: row.title, published, from: row.url, to: want };
  }
  const url = (await place(env, row.url, published, row.id)) as string | null;
  const thumb = row.thumb_url && row.thumb_url !== row.url
    ? ((await place(env, row.thumb_url, published, row.id)) as string | null)
    : row.thumb_url === row.url ? url : row.thumb_url;
  if (url === row.url && thumb === row.thumb_url) return null;
  await env.DB.prepare("UPDATE photos SET url = ?, thumb_url = ? WHERE id = ?").bind(url, thumb, row.id).run();
  return { id: row.id, title: row.title, published, from: row.url, to: url };
}
