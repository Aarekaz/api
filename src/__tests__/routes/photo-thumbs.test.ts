import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../types/env";
import photosRoute from "../../routes/photos";
import { testD1, type TestD1 } from "../helpers/d1";
import { thumbKeyFor } from "../../services/photo-thumbs";

// Thumbnails sit beside their original in the same bucket, so a hidden
// photo's thumbnail is private and publishing copies it out with the photo.

function bucket() {
  const objects = new Map<string, { data: ArrayBuffer; contentType?: string }>();
  const r2 = {
    async put(key: string, value: ReadableStream | ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
      const data = value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer();
      objects.set(key, { data, contentType: options?.httpMetadata?.contentType });
      return {};
    },
    async head(key: string) { return objects.has(key) ? { key } : null; },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return { body: new Response(o.data).body, httpMetadata: { contentType: o.contentType }, arrayBuffer: async () => o.data };
    },
    async delete(key: string) { objects.delete(key); },
  } as unknown as R2Bucket;
  return { objects, r2 };
}

/** A stand-in for the Images binding: the "thumbnail" is the first byte of the input, as WebP. */
function images(opts: { fail?: boolean } = {}) {
  const calls: Array<{ width?: number }> = [];
  const binding = {
    input(stream: ReadableStream) {
      let transform: { width?: number } = {};
      const chain = {
        transform(t: { width?: number }) { transform = t; return chain; },
        async output() {
          if (opts.fail) throw new Error("not an image");
          calls.push(transform);
          const bytes = new Uint8Array(await new Response(stream).arrayBuffer()).slice(0, 1);
          return { response: () => new Response(bytes, { headers: { "Content-Type": "image/webp" } }), contentType: () => "image/webp" };
        },
      };
      return chain;
    },
  } as unknown as ImagesBinding;
  return { binding, calls };
}

let d1: TestD1 | undefined;
afterEach(() => { d1?.db.close(); d1 = undefined; });

const setup = (withImages: ReturnType<typeof images> | null = images()) => {
  d1 = testD1({ migrations: "all" });
  const media = bucket();
  const vault = bucket();
  const env = {
    API_TOKEN: "secret", DB: d1.DB, R2_BUCKET: media.r2, R2_PRIVATE: vault.r2,
    R2_PUBLIC_BASE_URL: "https://media.example.com", API_BASE_URL: "https://api.example.com",
    ...(withImages ? { IMAGES: withImages.binding } : {}),
  } as Env;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    photosRoute.request(path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) }, env);
  const row = (id: number) => d1!.db.prepare("SELECT url, thumb_url, published FROM photos WHERE id = ?").get(id) as { url: string; thumb_url: string | null; published: number };
  const lastId = () => (d1!.db.prepare("SELECT MAX(id) AS id FROM photos").get() as { id: number }).id;
  const upload = async () => {
    const res = await call("POST", "/upload", new Uint8Array([7, 8, 9]), { "Content-Type": "image/jpeg", "Content-Length": "3" });
    expect(res.status).toBe(201);
    return res.json() as Promise<{ key: string; url: string; thumb_key?: string; thumb_url?: string }>;
  };
  return { env, media, vault, call, row, lastId, upload };
};

describe("photo thumbnails", () => {
  it("makes a private thumbnail on upload and the row picks it up", async () => {
    const tools = images();
    const { media, vault, call, row, lastId, upload } = setup(tools);
    const up = await upload();
    expect(up.thumb_key).toBe(thumbKeyFor(up.key));
    expect(up.thumb_url).toBe(`https://api.example.com/v1/photos/file/${up.thumb_key!.slice("photos/".length)}`);
    expect(vault.objects.get(up.thumb_key!)?.contentType).toBe("image/webp");
    expect(media.objects.size).toBe(0);
    expect(tools.calls).toEqual([{ width: 800, fit: "scale-down" }]);

    // An older app sends no thumb_url: the one made on upload is used, and stays private.
    expect((await call("POST", "/", { url: up.url, published: false })).status).toBe(201);
    expect(row(lastId())).toEqual({ url: up.url, thumb_url: up.thumb_url, published: 0 });
    expect(media.objects.size).toBe(0);
  });

  it("publishes the thumbnail with its photo and takes it down with it", async () => {
    const { media, call, row, lastId, upload } = setup();
    const up = await upload();
    await call("POST", "/", { url: up.url, published: false });
    const id = lastId();
    await call("PATCH", `/${id}`, { published: true });
    const published = row(id);
    expect(published.thumb_url).toBe(`https://media.example.com/${up.thumb_key}`);
    expect(media.objects.has(up.thumb_key!)).toBe(true);
    await call("PATCH", `/${id}`, { published: false });
    expect(row(id).thumb_url).toBe(up.thumb_url);
    expect(media.objects.has(up.thumb_key!)).toBe(false);
  });

  it("serves a private thumbnail only through the signed-in route", async () => {
    const { call, upload } = setup();
    const up = await upload();
    const res = await call("GET", `/file/${up.thumb_key!.slice("photos/".length)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("answers uploads as before without the binding, or when the image can't be read", async () => {
    for (const tools of [null, images({ fail: true })]) {
      const { vault, upload } = setup(tools);
      const up = await upload();
      expect(Object.keys(up).sort()).toEqual(["content_type", "key", "ok", "url"]);
      expect(vault.objects.size).toBe(1);
      d1?.db.close(); d1 = undefined;
    }
  });

  it("backfills thumbnails for older photos, a few at a time", async () => {
    const { vault, media, call, row, env } = setup();
    const names = ["0f8fad5b-d9cb-469f-a165-70867728950e.jpg", "1f8fad5b-d9cb-469f-a165-70867728950e.jpg"];
    await vault.r2.put(`photos/${names[0]}`, new Uint8Array([1]).buffer);
    await vault.r2.put(`photos/${names[1]}`, new Uint8Array([2]).buffer);
    await media.r2.put(`photos/${names[1]}`, new Uint8Array([2]).buffer);
    d1!.db.prepare("INSERT INTO photos (url, published, created_at) VALUES (?, 0, '2026-01-01')").run(`https://api.example.com/v1/photos/file/${names[0]}`);
    d1!.db.prepare("INSERT INTO photos (url, published, created_at) VALUES (?, 1, '2026-01-01')").run(`https://media.example.com/photos/${names[1]}`);

    const dry = await (await call("POST", "/thumbs")).json() as { missing: number; made: unknown[] };
    expect(dry).toMatchObject({ applied: false, available: true, missing: 2, made: [] });

    const one = await (await call("POST", "/thumbs?apply=1&limit=1")).json() as { missing: number; made: Array<{ id: number }> };
    expect(one.made.map((m) => m.id)).toEqual([1]);
    expect(one.missing).toBe(1);
    const rest = await (await call("POST", "/thumbs?apply=1")).json() as { missing: number };
    expect(rest.missing).toBe(0);

    const hidden = thumbKeyFor(`photos/${names[0]}`);
    const shown = thumbKeyFor(`photos/${names[1]}`);
    expect(row(1).thumb_url).toBe(`https://api.example.com/v1/photos/file/${hidden.slice(7)}`);
    expect(media.objects.has(hidden)).toBe(false);
    expect(row(2).thumb_url).toBe(`https://media.example.com/${shown}`);
    expect(media.objects.has(shown)).toBe(true);
    void env;
  });

  it("says thumbnails are off without the binding", async () => {
    const { call } = setup(null);
    expect(await (await call("POST", "/thumbs?apply=1")).json()).toEqual({ ok: true, applied: false, available: false, missing: 0, made: [] });
  });
});
