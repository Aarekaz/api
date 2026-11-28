import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../types/env";
import photosRoute from "../../routes/photos";
import { testD1, type TestD1 } from "../helpers/d1";

// "Only you" photos never have a public address: uploads go to the private
// bucket and are read through /v1/photos/file/<name>; publishing copies the
// file to the public bucket, taking it down removes that copy. Photos
// uploaded before this (only a public copy) move when checked.

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

const NAME = "0f8fad5b-d9cb-469f-a165-70867728950e.jpg";
const PUBLIC = `https://media.example.com/photos/${NAME}`;
const PRIVATE = `https://api.example.com/v1/photos/file/${NAME}`;

let d1: TestD1 | undefined;
afterEach(() => { d1?.db.close(); d1 = undefined; });

const setup = () => {
  d1 = testD1({ migrations: "all" });
  const media = bucket();
  const vault = bucket();
  const env = {
    API_TOKEN: "secret", DB: d1.DB, R2_BUCKET: media.r2, R2_PRIVATE: vault.r2,
    R2_PUBLIC_BASE_URL: "https://media.example.com", API_BASE_URL: "https://api.example.com",
  } as Env;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    photosRoute.request(path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }, env);
  const row = (id: number) => d1!.db.prepare("SELECT url, published FROM photos WHERE id = ?").get(id) as { url: string; published: number };
  return { env, media, vault, call, row, db: d1.db };
};

describe("private photos", () => {
  it("stores an upload in the private bucket and answers its private address", async () => {
    const { media, vault, call } = setup();
    const res = await call("POST", "/upload", new Uint8Array([1, 2, 3]), { "Content-Type": "image/jpeg", "Content-Length": "3" });
    expect(res.status).toBe(201);
    const body = await res.json() as { key: string; url: string };
    expect(body.url).toBe(`https://api.example.com/v1/photos/file/${body.key.slice("photos/".length)}`);
    expect(vault.objects.has(body.key)).toBe(true);
    expect(media.objects.size).toBe(0);
  });

  it("keeps a hidden photo private, copies it out on publish and removes the copy on unpublish", async () => {
    const { media, vault, call, row } = setup();
    await vault.r2.put(`photos/${NAME}`, new Uint8Array([9]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
    expect((await call("POST", "/", { url: PRIVATE, title: "Dusk", published: false })).status).toBe(201);
    expect(row(1).url).toBe(PRIVATE);
    expect(media.objects.size).toBe(0);

    await call("PATCH", "/1", { published: true });
    expect(row(1).url).toBe(PUBLIC);
    expect(media.objects.has(`photos/${NAME}`)).toBe(true);

    await call("PATCH", "/1", { published: false });
    expect(row(1).url).toBe(PRIVATE);
    expect(media.objects.has(`photos/${NAME}`)).toBe(false);
    expect(vault.objects.has(`photos/${NAME}`)).toBe(true);
  });

  it("serves a private file through the signed-in route only for real names", async () => {
    const { vault, call } = setup();
    await vault.r2.put(`photos/${NAME}`, new Uint8Array([7, 7]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
    const res = await call("GET", `/file/${NAME}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 7]));
    expect((await call("GET", "/file/..%2Fsecrets.jpg")).status).toBe(404);
  });

  it("lists, then moves, older hidden photos whose only copy is public", async () => {
    const { media, vault, call, row, db } = setup();
    await media.r2.put(`photos/${NAME}`, new Uint8Array([5]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
    db.prepare("INSERT INTO photos (title, url, published, created_at, updated_at) VALUES ('Old', ?, 0, 'x', 'x')").run(PUBLIC);
    db.prepare("INSERT INTO photos (title, url, published, created_at, updated_at) VALUES ('Elsewhere', 'https://other.example/p.jpg', 0, 'x', 'x')").run();

    const dry = await (await call("POST", "/privacy")).json() as { applied: boolean; moves: { id: number; to: string }[]; unmovable: { id: number }[] };
    expect(dry.applied).toBe(false);
    expect(dry.moves).toEqual([{ id: 1, title: "Old", published: false, from: PUBLIC, to: PRIVATE }]);
    expect(dry.unmovable.map((u) => u.id)).toEqual([2]);
    expect(row(1).url).toBe(PUBLIC);

    await call("POST", "/privacy?apply=1");
    expect(row(1).url).toBe(PRIVATE);
    expect(vault.objects.has(`photos/${NAME}`)).toBe(true);
    expect(media.objects.has(`photos/${NAME}`)).toBe(false);
  });

  it("leaves a photo it can't find a file for as it was", async () => {
    const { call, row } = setup();
    await call("POST", "/", { url: PUBLIC, published: false });
    expect(row(1).url).toBe(PUBLIC);
  });
});
