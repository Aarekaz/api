import { describe, expect, it } from "vitest";
import type { Env } from "../../types/env";
import photosRoute from "../../routes/photos";
import blogImagesRoute from "../../routes/blog-images";
import { signUploadToken, verifyUploadToken } from "../../services/upload-token";

// Presign, then PUT with the token: one token module for photos and blog
// images (services/upload-token.ts). A malformed token is a 403 like a forged
// one (it was a 500), and a token only works on the route that signed it.

function bucket() {
  const objects = new Map<string, { size: number; contentType?: string }>();
  return {
    objects,
    r2: {
      async put(key: string, value: ReadableStream | ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
        const size = value instanceof ArrayBuffer ? value.byteLength : (await new Response(value).arrayBuffer()).byteLength;
        objects.set(key, { size, contentType: options?.httpMetadata?.contentType });
        return {};
      },
    } as unknown as R2Bucket,
  };
}

const ROUTES = [
  { name: "photos", route: photosRoute, prefix: "photos/", type: "image/jpeg" },
  { name: "blog-images", route: blogImagesRoute, prefix: "blog/", type: "image/png" },
];

describe.each(ROUTES)("$name presigned upload", ({ route, prefix, type }) => {
  const setup = () => {
    const store = bucket();
    const env = { API_TOKEN: "secret", R2_BUCKET: store.r2, R2_PUBLIC_BASE_URL: "https://media.example.com" } as Env;
    return { store, env };
  };

  it("signs a key under its prefix and accepts the PUT once signed", async () => {
    const { store, env } = setup();
    const presign = await (await route.request("/presign", { method: "POST", headers: { "X-Content-Type": type } }, env)).json() as { key: string; uploadToken: string; expiresIn: number };
    expect(presign.key.startsWith(prefix)).toBe(true);
    expect(presign.expiresIn).toBe(300);
    const put = await route.request("/upload-presigned", { method: "PUT", headers: { "X-Upload-Token": presign.uploadToken, "Content-Type": type }, body: new Uint8Array([1, 2, 3]) }, env);
    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ ok: true, key: presign.key, url: `https://media.example.com/${presign.key}`, content_type: type });
    expect(store.objects.get(presign.key)).toEqual({ size: 3, contentType: type });
  });

  it("refuses a missing, malformed, forged or expired token", async () => {
    const { env } = setup();
    const put = (token?: string) => route.request("/upload-presigned", { method: "PUT", headers: token ? { "X-Upload-Token": token } : {}, body: "x" }, env);
    const missing = await put();
    expect([missing.status, await missing.json()]).toEqual([401, { error: "Missing upload token" }]);
    const forged = await signUploadToken(`${prefix}a.png`, type, "other-secret");
    const expired = await signUploadToken(`${prefix}a.png`, type, "secret", Date.now() - 10 * 60 * 1000);
    for (const token of ["nope", "%%%.zz", "bm90IGpzb24=.00", "e30=.abc", forged, expired]) {
      const res = await put(token);
      expect(res.status, token).toBe(403);
      expect(await res.json()).toEqual({ error: "Invalid or expired upload token" });
    }
  });
});

describe("upload tokens across routes", () => {
  it("a photos token can't write to blog/ and a blog token can't write to photos/", async () => {
    const env = { API_TOKEN: "secret", R2_BUCKET: bucket().r2 } as Env;
    const photoToken = await signUploadToken("photos/x.jpg", "image/jpeg", "secret");
    const blogToken = await signUploadToken("blog/x.png", "image/png", "secret");
    expect((await blogImagesRoute.request("/upload-presigned", { method: "PUT", headers: { "X-Upload-Token": photoToken }, body: "x" }, env)).status).toBe(403);
    expect((await photosRoute.request("/upload-presigned", { method: "PUT", headers: { "X-Upload-Token": blogToken }, body: "x" }, env)).status).toBe(403);
    expect(await verifyUploadToken(photoToken, "secret", "photos/")).toEqual({ key: "photos/x.jpg", contentType: "image/jpeg" });
  });

  it("expires after five minutes", async () => {
    const t0 = Date.parse("2026-11-20T10:00:00Z");
    const token = await signUploadToken("blog/x.png", "image/png", "s", t0);
    expect(await verifyUploadToken(token, "s", "blog/", t0 + 299_000)).not.toBeNull();
    expect(await verifyUploadToken(token, "s", "blog/", t0 + 301_000)).toBeNull();
  });
});
