import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../types/env";
import photosRoute from "../../routes/photos";
import blogImagesRoute from "../../routes/blog-images";
import { signUploadToken, spendUploadToken, UPLOAD_LIMITS, uploadSecret, verifyUploadToken } from "../../services/upload-token";
import { testD1, type TestD1 } from "../helpers/d1";

// Presign, then PUT with the token: one token module and one set of handlers
// for photos and blog images (services/upload-token.ts, lib/uploads.ts). A
// malformed token is a 403 like a forged one; a token only works on the route
// that signed it, and only once; only raster images are stored.

function bucket(fail = false) {
  const objects = new Map<string, { size: number; contentType?: string }>();
  return {
    objects,
    r2: {
      async put(key: string, value: ReadableStream | ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
        if (fail) throw new Error("R2 is down");
        const size = value instanceof ArrayBuffer ? value.byteLength : (await new Response(value).arrayBuffer()).byteLength;
        objects.set(key, { size, contentType: options?.httpMetadata?.contentType });
        return {};
      },
    } as unknown as R2Bucket,
  };
}

const ROUTES = [
  { name: "photos", kind: "photo", route: photosRoute, prefix: "photos/", type: "image/jpeg", max: UPLOAD_LIMITS.photosPresigned, direct: UPLOAD_LIMITS.photosDirect },
  { name: "blog-images", kind: "blog", route: blogImagesRoute, prefix: "blog/", type: "image/png", max: UPLOAD_LIMITS.blogPresigned, direct: UPLOAD_LIMITS.blogDirect },
] as const;

let d1: TestD1 | undefined;
afterEach(() => { d1?.db.close(); d1 = undefined; });

const setup = (options: { migrated?: boolean; failingBucket?: boolean; env?: Partial<Env> } = {}) => {
  d1 = testD1({ migrations: options.migrated === false ? [] : ["0056_upload_tokens"] });
  const store = bucket(options.failingBucket);
  const env = { API_TOKEN: "secret", DB: d1.DB, R2_BUCKET: store.r2, R2_PUBLIC_BASE_URL: "https://media.example.com", ...options.env } as Env;
  return { store, env, db: d1.db };
};

const bytes = (n: number) => ({ body: new Uint8Array(n), length: String(n) });

describe.each(ROUTES)("$name presigned upload", ({ kind, route, prefix, type, max, direct }) => {
  const presign = async (env: Env, contentType: string = type) =>
    (await route.request("/presign", { method: "POST", headers: { "X-Content-Type": contentType } }, env)).json() as Promise<{ key: string; uploadToken: string; uploadUrl: string; expiresIn: number }>;
  const put = (env: Env, token: string, n = 3, headers: Record<string, string> = {}) => {
    const { body, length } = bytes(n);
    return route.request("/upload-presigned", { method: "PUT", headers: { "X-Upload-Token": token, "Content-Type": type, "Content-Length": length, ...headers }, body }, env);
  };

  it("signs a key under its prefix and accepts the PUT once signed", async () => {
    const { store, env } = setup();
    const signed = await presign(env);
    expect(signed.key.startsWith(prefix)).toBe(true);
    expect(signed.expiresIn).toBe(300);
    expect(signed.uploadUrl).toBe(`https://api.anuragd.me/v1/${kind === "photo" ? "photos" : "blog-images"}/upload-presigned`);
    const res = await put(env, signed.uploadToken);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, key: signed.key, url: `https://media.example.com/${signed.key}`, content_type: type });
    expect(store.objects.get(signed.key)).toEqual({ size: 3, contentType: type });
  });

  it("refuses a missing, malformed, forged or expired token", async () => {
    const { env } = setup();
    const call = (token?: string) => route.request("/upload-presigned", { method: "PUT", headers: { "Content-Length": "1", ...(token ? { "X-Upload-Token": token } : {}) }, body: "x" }, env);
    const missing = await call();
    expect([missing.status, await missing.json()]).toEqual([401, { error: "Missing upload token" }]);
    const forged = await signUploadToken(kind, `${prefix}a.png`, type, "other-secret");
    const expired = await signUploadToken(kind, `${prefix}a.png`, type, "secret", Date.now() - 10 * 60 * 1000);
    for (const token of ["nope", "%%%.zz", "bm90IGpzb24=.00", "e30=.abc", forged, expired]) {
      const res = await call(token);
      expect(res.status, token).toBe(403);
      expect(await res.json()).toEqual({ error: "Invalid or expired upload token" });
    }
  });

  it("spends a token on its first PUT: a second one is a 403 and stores nothing", async () => {
    const { store, env, db } = setup();
    const { uploadToken, key } = await presign(env);
    expect((await put(env, uploadToken, 3)).status).toBe(201);
    const again = await put(env, uploadToken, 5);
    expect([again.status, await again.json()]).toEqual([403, { error: "Upload token already used" }]);
    expect(store.objects.get(key)?.size).toBe(3);
    expect(db.prepare("SELECT key FROM upload_tokens").all()).toEqual([{ key }]);
  });

  it("gives the token back when R2 fails, so the same PUT can be retried", async () => {
    const down = setup({ failingBucket: true });
    const { uploadToken } = await presign(down.env);
    expect((await put(down.env, uploadToken)).status).toBe(500);
    expect(down.db.prepare("SELECT key FROM upload_tokens").all()).toEqual([]);
  });

  it("works as before (reusable) until migration 0056 is applied", async () => {
    const { env } = setup({ migrated: false });
    const { uploadToken } = await presign(env);
    expect((await put(env, uploadToken)).status).toBe(201);
    expect((await put(env, uploadToken)).status).toBe(201);
  });

  it("refuses a body over its cap (413), with no length (411) or empty (400), without spending the token", async () => {
    const { store, env, db } = setup();
    const { uploadToken } = await presign(env);
    // Hono's test request keeps the declared length; the body itself is small.
    const declared = (length: string | undefined) => route.request("/upload-presigned", {
      method: "PUT",
      headers: { "X-Upload-Token": uploadToken, "Content-Type": type, ...(length === undefined ? {} : { "Content-Length": length }) },
      body: new Uint8Array([1]),
    }, env);
    const over = await declared(String(max + 1));
    expect([over.status, await over.json()]).toEqual([413, { error: "File too large" }]);
    for (const length of [undefined, "", "abc", "-1", "1.5"]) {
      const res = await declared(length);
      expect([res.status, await res.json()], String(length)).toEqual([411, { error: "Length required" }]);
    }
    const empty = await declared("0");
    expect([empty.status, await empty.json()]).toEqual([400, { error: "Missing body" }]);
    expect(store.objects.size).toBe(0);
    expect(db.prepare("SELECT key FROM upload_tokens").all()).toEqual([]);
    // A bad token is still a 403 first, whatever the size.
    const forged = await route.request("/upload-presigned", { method: "PUT", headers: { "X-Upload-Token": "nope", "Content-Length": String(max + 1) }, body: "x" }, env);
    expect(forged.status).toBe(403);
  });

  it("refuses SVG and anything that isn't a raster image, at presign and on the direct upload", async () => {
    const { env } = setup();
    for (const contentType of ["image/svg+xml", "image/svg+xml; charset=utf-8", "text/html", "application/octet-stream", "image/x-icon", "image/*"]) {
      const res = await route.request("/presign", { method: "POST", headers: { "X-Content-Type": contentType } }, env);
      expect([res.status, await res.json()], contentType).toEqual([415, { error: "Unsupported content type" }]);
      const direct = await route.request("/upload", { method: "POST", headers: { "Content-Type": contentType, "Content-Length": "1" }, body: "x" }, env);
      expect(direct.status, contentType).toBe(415);
    }
  });

  it("keeps the direct upload cap and needs a length there too", async () => {
    const { env } = setup();
    const post = (length?: string) => route.request("/upload", { method: "POST", headers: { "Content-Type": type, ...(length ? { "Content-Length": length } : {}) }, body: new Uint8Array([1]) }, env);
    const over = await post(String(direct + 1));
    expect([over.status, await over.json()]).toEqual([413, { error: "File too large" }]);
    expect((await post(String(direct))).status).not.toBe(413);
    expect((await post()).status).toBe(411);
  });

  it("signs with UPLOAD_TOKEN_SECRET once it is set, and API_TOKEN's tokens stop working", async () => {
    const { env } = setup({ env: { UPLOAD_TOKEN_SECRET: "upload-secret" } });
    expect(uploadSecret(env)).toBe("upload-secret");
    const { uploadToken } = await presign(env);
    expect(await verifyUploadToken(uploadToken, "upload-secret", kind)).not.toBeNull();
    expect(await verifyUploadToken(uploadToken, "secret", kind)).toBeNull();
    const old = await signUploadToken(kind, `${prefix}x.png`, type, "secret");
    expect((await put(env, old)).status).toBe(403);
    expect((await put(env, uploadToken)).status).toBe(201);
  });
});

describe("photo types", () => {
  it("takes every raster type, stored under its own extension, and reads image/jpg as image/jpeg", async () => {
    const { env, store } = setup();
    const cases: Array<[string, string, string]> = [
      ["image/jpeg", "image/jpeg", "jpg"], ["image/jpg", "image/jpeg", "jpg"], ["IMAGE/PNG", "image/png", "png"],
      ["image/heic", "image/heic", "heic"], ["image/heif", "image/heif", "heif"], ["image/webp", "image/webp", "webp"],
      ["image/gif", "image/gif", "gif"], ["image/avif", "image/avif", "avif"],
    ];
    for (const [sent, stored, ext] of cases) {
      const res = await photosRoute.request("/upload", { method: "POST", headers: { "Content-Type": sent, "Content-Length": "1" }, body: "x" }, env);
      expect(res.status, sent).toBe(201);
      const { key, content_type } = await res.json() as { key: string; content_type: string };
      expect([content_type, key.split(".").pop(), store.objects.get(key)?.contentType], sent).toEqual([stored, ext, stored]);
    }
  });

  it("blog images stay PNG, JPEG or WebP", async () => {
    const { env } = setup();
    for (const type of ["image/heic", "image/gif", "image/avif"]) {
      expect((await blogImagesRoute.request("/presign", { method: "POST", headers: { "X-Content-Type": type } }, env)).status, type).toBe(415);
    }
  });
});

describe("upload tokens across routes", () => {
  it("a photo token can't write to blog/ and a blog token can't write to photos/", async () => {
    const { env } = setup();
    const photoToken = await signUploadToken("photo", "photos/x.jpg", "image/jpeg", "secret");
    const blogToken = await signUploadToken("blog", "blog/x.png", "image/png", "secret");
    const put = (route: typeof photosRoute, token: string) =>
      route.request("/upload-presigned", { method: "PUT", headers: { "X-Upload-Token": token, "Content-Length": "1" }, body: "x" }, env);
    expect((await put(blogImagesRoute, photoToken)).status).toBe(403);
    expect((await put(photosRoute, blogToken)).status).toBe(403);
    expect(await verifyUploadToken(photoToken, "secret", "photo")).toEqual({ key: "photos/x.jpg", contentType: "image/jpeg", exp: expect.any(Number) });
    // The kind is what scopes a token: a blog-kind token for a photos/ key is refused on both routes.
    const mixed = await signUploadToken("blog", "photos/x.jpg", "image/jpeg", "secret");
    expect(await verifyUploadToken(mixed, "secret", "photo")).toBeNull();
    expect(await verifyUploadToken(mixed, "secret", "blog")).toBeNull();
    // A token signed for SVG (before this check existed) is refused too.
    expect(await verifyUploadToken(await signUploadToken("photo", "photos/x.svg", "image/svg+xml", "secret"), "secret", "photo")).toBeNull();
  });

  it("expires after five minutes", async () => {
    const t0 = Date.parse("2026-11-20T10:00:00Z");
    const token = await signUploadToken("blog", "blog/x.png", "image/png", "s", t0);
    expect(await verifyUploadToken(token, "s", "blog", t0 + 299_000)).not.toBeNull();
    expect(await verifyUploadToken(token, "s", "blog", t0 + 301_000)).toBeNull();
  });

  it("spending clears expired rows first", async () => {
    const { env, db } = setup();
    const t0 = Date.parse("2026-11-20T10:00:00Z");
    expect(await spendUploadToken(env, { key: "photos/a.jpg", contentType: "image/jpeg", exp: t0 + 300_000 }, t0)).toBe(true);
    expect(await spendUploadToken(env, { key: "photos/a.jpg", contentType: "image/jpeg", exp: t0 + 300_000 }, t0 + 1000)).toBe(false);
    expect(await spendUploadToken(env, { key: "photos/b.jpg", contentType: "image/jpeg", exp: t0 + 700_000 }, t0 + 400_000)).toBe(true);
    expect(db.prepare("SELECT key FROM upload_tokens").all()).toEqual([{ key: "photos/b.jpg" }]);
  });
});
