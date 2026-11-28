import type { Env } from "../types/env";

// Presigned upload tokens for PUT /v1/photos/upload-presigned and
// /v1/blog-images/upload-presigned: base64(JSON { kind, key, contentType, exp })
// "." hex HMAC-SHA-256 of that JSON, valid five minutes. The R2 key is chosen by
// the server when it signs, so the uploader can't pick where the bytes go; the
// kind ties a token to the route that signed it; each token is spent by its
// first PUT (migrations/0056_upload_tokens.sql).

const LIFETIME_MILLISECONDS = 5 * 60 * 1000;
const MIB = 1024 * 1024;

/**
 * The largest body each upload route stores. Presigned PUTs exist to get past
 * the OS proxy's 4.5 MB limit, so their caps sit well above a full-size camera
 * JPEG or a Retina screenshot and well below the platform's 100 MB body limit.
 */
export const UPLOAD_LIMITS = {
  photosDirect: 10 * MIB,
  photosPresigned: 50 * MIB,
  blogDirect: 5 * MIB,
  blogPresigned: 25 * MIB,
  // A recipe's photo: a camera shot of the dish, or a picture saved from a post.
  recipeDirect: 15 * MIB,
  recipePresigned: 50 * MIB,
} as const;

/**
 * Raster images only. The bucket is served from media.anuragd.me, so a type a
 * browser runs (SVG is script, so is HTML) would be stored XSS there.
 */
export const RASTER_IMAGE_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/gif", "image/avif"] as const;

export type UploadKind = "photo" | "blog" | "recipe";

/** What each kind of upload may store, and where. */
export const UPLOAD_KINDS: Record<UploadKind, {
  /** Where the route is mounted (its presign answers with this route's upload URL). */
  route: string;
  prefix: string;
  types: readonly string[];
  /** The type a presign assumes when X-Content-Type is missing. */
  defaultType: string;
  directMax: number;
  presignedMax: number;
}> = {
  photo: { route: "/v1/photos", prefix: "photos/", types: RASTER_IMAGE_TYPES, defaultType: "image/jpeg", directMax: UPLOAD_LIMITS.photosDirect, presignedMax: UPLOAD_LIMITS.photosPresigned },
  // Blog images are embedded in posts, so only what every browser shows.
  blog: { route: "/v1/blog-images", prefix: "blog/", types: ["image/png", "image/jpeg", "image/webp"], defaultType: "image/png", directMax: UPLOAD_LIMITS.blogDirect, presignedMax: UPLOAD_LIMITS.blogPresigned },
  // Recipe photos answer in the recipes route's own shape (routes/recipes.ts); only the rules are shared.
  recipe: { route: "/v1/recipes", prefix: "recipes/", types: RASTER_IMAGE_TYPES, defaultType: "image/jpeg", directMax: UPLOAD_LIMITS.recipeDirect, presignedMax: UPLOAD_LIMITS.recipePresigned },
};

/** A Content-Type header as one of `allowed` (parameters dropped, lower case, image/jpg read as image/jpeg), or null. */
export function imageType(header: string | undefined, allowed: readonly string[]): string | null {
  const type = (header ?? "").split(";")[0].trim().toLowerCase();
  const canonical = type === "image/jpg" ? "image/jpeg" : type;
  return allowed.includes(canonical) ? canonical : null;
}

/**
 * Why an upload's declared size is refused, or null when it is fine. The
 * runtime holds a body to its declared length and R2 can't store a body of
 * unknown length, so the header is the check: none (or not a number) is 411,
 * zero is 400, over `max` is 413.
 */
export function sizeProblem(contentLength: string | undefined, max: number): { status: 400 | 411 | 413; message: string } | null {
  if (!contentLength || !/^\d+$/.test(contentLength.trim())) return { status: 411, message: "Length required" };
  const length = Number(contentLength);
  if (length === 0) return { status: 400, message: "Missing body" };
  if (length > max) return { status: 413, message: "File too large" };
  return null;
}

/**
 * The key tokens are signed with: UPLOAD_TOKEN_SECRET when it is set, so the
 * owner's API token isn't also an HMAC key; until then API_TOKEN, as before.
 * Changing it voids the tokens signed in the last five minutes, nothing more.
 */
export const uploadSecret = (env: Pick<Env, "API_TOKEN" | "UPLOAD_TOKEN_SECRET">): string => env.UPLOAD_TOKEN_SECRET || env.API_TOKEN;

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

export async function signUploadToken(kind: UploadKind, key: string, contentType: string, secret: string, now = Date.now()): Promise<string> {
  const payload = JSON.stringify({ kind, key, contentType, exp: now + LIFETIME_MILLISECONDS });
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(payload));
  const sigHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return btoa(payload) + "." + sigHex;
}

export interface UploadClaim { key: string; contentType: string; exp: number }

/**
 * The claim in a token, or null when it is malformed, forged, expired, or for
 * another kind (a photo token on the blog route, or the reverse; its key must
 * be under that kind's prefix too). Never throws: a token that isn't even
 * base64 is just not valid.
 */
export async function verifyUploadToken(token: string, secret: string, kind: UploadKind, now = Date.now()): Promise<UploadClaim | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !/^(?:[0-9a-f]{2})+$/i.test(parts[1])) return null;
  try {
    const payload = atob(parts[0]);
    const sigBytes = new Uint8Array(parts[1].match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sigBytes, new TextEncoder().encode(payload));
    if (!valid) return null;
    const data = JSON.parse(payload) as { kind?: unknown; key?: unknown; contentType?: unknown; exp?: unknown };
    if (typeof data.exp !== "number" || now > data.exp) return null;
    if (data.kind !== kind || typeof data.key !== "string" || !data.key.startsWith(UPLOAD_KINDS[kind].prefix)) return null;
    if (typeof data.contentType !== "string" || !UPLOAD_KINDS[kind].types.includes(data.contentType)) return null;
    return { key: data.key, contentType: data.contentType, exp: data.exp };
  } catch {
    return null;
  }
}

const missingTable = (error: unknown) => /no such table: upload_tokens/i.test(String(error));

/**
 * Spends a token: true the first time, false once it has been used. Expired
 * rows go first (a spent token is refused by its expiry after that). Before
 * migration 0056 is applied there is nowhere to remember, so every PUT is let
 * through as before.
 */
export async function spendUploadToken(env: Pick<Env, "DB">, claim: UploadClaim, now = Date.now()): Promise<boolean> {
  try {
    const [, insert] = await env.DB.batch([
      env.DB.prepare("DELETE FROM upload_tokens WHERE expires_at < ?").bind(now),
      env.DB.prepare("INSERT INTO upload_tokens (key, expires_at, used_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
        .bind(claim.key, claim.exp, new Date(now).toISOString()),
    ]);
    return Number(insert.meta?.changes ?? 0) === 1;
  } catch (error) {
    if (missingTable(error)) return true;
    throw error;
  }
}

/** Gives a token back when its PUT failed to store anything, so the client can retry it. */
export async function refundUploadToken(env: Pick<Env, "DB">, claim: UploadClaim): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM upload_tokens WHERE key = ?").bind(claim.key).run();
  } catch (error) {
    if (!missingTable(error)) console.error("upload token refund failed", error);
  }
}
