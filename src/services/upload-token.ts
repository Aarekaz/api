// Presigned upload tokens for PUT /v1/photos/upload-presigned and
// /v1/blog-images/upload-presigned: base64(JSON { key, contentType, exp }) "."
// hex HMAC-SHA-256 of that JSON, valid five minutes. The R2 key is chosen by
// the server when it signs, so the uploader can't pick where the bytes go.

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
} as const;

/**
 * Whether a request's Content-Length is over `max`. The runtime holds a body to
 * its declared length, and R2 can't store a body of unknown length, so the
 * header is the check.
 */
export const declaresMoreThan = (contentLength: string | undefined, max: number): boolean =>
  Boolean(contentLength) && Number(contentLength) > max;

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

export async function signUploadToken(key: string, contentType: string, secret: string, now = Date.now()): Promise<string> {
  const payload = JSON.stringify({ key, contentType, exp: now + LIFETIME_MILLISECONDS });
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(payload));
  const sigHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return btoa(payload) + "." + sigHex;
}

/**
 * The claim in a token, or null when it is malformed, forged, expired, or for
 * a key outside `prefix` (a photos token on the blog route, or the reverse).
 * Never throws: a token that isn't even base64 is just not valid.
 */
export async function verifyUploadToken(
  token: string,
  secret: string,
  prefix: string,
  now = Date.now(),
): Promise<{ key: string; contentType: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !/^(?:[0-9a-f]{2})+$/i.test(parts[1])) return null;
  try {
    const payload = atob(parts[0]);
    const sigBytes = new Uint8Array(parts[1].match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sigBytes, new TextEncoder().encode(payload));
    if (!valid) return null;
    const data = JSON.parse(payload) as { key?: unknown; contentType?: unknown; exp?: unknown };
    if (typeof data.exp !== "number" || now > data.exp) return null;
    if (typeof data.key !== "string" || !data.key.startsWith(prefix) || typeof data.contentType !== "string") return null;
    return { key: data.key, contentType: data.contentType };
  } catch {
    return null;
  }
}
