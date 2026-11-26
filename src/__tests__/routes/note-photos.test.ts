// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
import { testD1 } from "../helpers/d1";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import documentsRoute, { captureRoute } from "../../routes/documents";
import { privatePhotoNames, publishNotePhotos } from "../../services/note-photos";

// Photos in notes: stored privately, read back only through the API, and copied
// to the public bucket only when a piece of writing goes on the site.

function d1(): D1Database {
  const { db, DB } = testD1();
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    summary TEXT, content TEXT, tags_json TEXT, published_at TEXT, pinned INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
  db.exec(readFileSync("migrations/0025_documents.sql", "utf8"));
  return DB;
}

/** An in-memory R2 bucket: put, get, head. */
function r2() {
  const objects = new Map<string, { data: Uint8Array; contentType?: string; cacheControl?: string }>();
  return {
    objects,
    bucket: {
      async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }) {
        objects.set(key, { data: new Uint8Array(value), contentType: options?.httpMetadata?.contentType, cacheControl: options?.httpMetadata?.cacheControl });
        return {};
      },
      async get(key: string) {
        const o = objects.get(key);
        return o ? { body: o.data, httpMetadata: { contentType: o.contentType }, arrayBuffer: async () => o.data.slice().buffer } : null;
      },
      async head(key: string) {
        return objects.has(key) ? { key } : null;
      },
    } as unknown as R2Bucket,
  };
}

function setup(options: { privateBucket?: boolean } = {}) {
  const priv = r2();
  const pub = r2();
  const env = {
    DB: d1(), R2_BUCKET: pub.bucket, R2_PUBLIC_BASE_URL: "https://media.example.test", API_BASE_URL: "https://api.example.test",
    ...(options.privateBucket === false ? {} : { R2_PRIVATE: priv.bucket }),
  } as Env;
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/documents", documentsRoute);
  root.route("/v1/capture", captureRoute);
  const upload = (bytes: Uint8Array, type = "image/jpeg") =>
    root.request("/v1/documents/photos", { method: "POST", body: bytes, headers: { "Content-Type": type } }, env);
  const send = (path: string, method = "GET", body?: unknown) =>
    root.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
  return { env, root, upload, send, priv, pub };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
type Uploaded = { ref: string; url: string; content_type: string; size: number };
type Captured = { ok: boolean; document?: { id: string; title: string; folder: string }; link?: unknown };

describe("note photos", () => {
  it("stores a photo in the private bucket and serves it only through the API", async () => {
    const { upload, root, env, priv, pub } = setup();
    const up = await upload(JPEG);
    expect(up.status).toBe(201);
    const photo = await up.json() as Uploaded;
    expect(photo.ref).toMatch(/^notes\/[0-9A-Za-z-]+\.jpg$/);
    expect(photo.url).toBe(`https://api.example.test/v1/documents/photos/${photo.ref.slice(6)}`);
    expect(priv.objects.get(photo.ref)?.cacheControl).toBe("private, max-age=31536000, immutable");
    expect(pub.objects.size).toBe(0);

    const back = await root.request(`/v1/documents/photos/${photo.ref.slice(6)}`, {}, env);
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("image/jpeg");
    expect(back.headers.get("cache-control")).toContain("private");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(JPEG);

    expect((await root.request("/v1/documents/photos/..%2Fjournal%2Fx.jpg", {}, env)).status).toBe(404);
    const missing = await root.request("/v1/documents/photos/01HZZZZZZZZZZZZZZZZZZZZZZZ-none.jpg", {}, env);
    expect([missing.status, await missing.json()]).toEqual([404, { error: { code: "not_found", message: "No such photo" } }]);
  });

  it("refuses what isn't an image, and never falls back to the public bucket", async () => {
    const { upload } = setup();
    const text = await upload(new TextEncoder().encode("hi"), "text/plain");
    expect([text.status, await text.json()]).toEqual([415, { error: { code: "invalid", message: "Send a JPEG, PNG, HEIC or WebP image" } }]);
    const empty = await upload(new Uint8Array(0), "image/png");
    expect(empty.status).toBe(400);

    const noPrivate = setup({ privateBucket: false });
    const refused = await noPrivate.upload(JPEG);
    expect(refused.status).toBe(503);
    expect(noPrivate.pub.objects.size).toBe(0);
  });

  it("captures shared photos as one Inbox note, after any words", async () => {
    const { upload, send, env } = setup();
    const a = await (await upload(JPEG)).json() as Uploaded;
    const b = await (await upload(JPEG, "image/png")).json() as Uploaded;

    const one = await send("/v1/capture", "POST", { photos: [a.ref] });
    expect(one.status).toBe(201);
    const onlyPhoto = await one.json() as Captured;
    expect(onlyPhoto.document).toMatchObject({ title: "Photo", folder: "Inbox" });

    const both = await (await send("/v1/capture", "POST", { text: "Shelf idea\nThe oak one", photos: [a.ref, b.ref.slice(6)] })).json() as Captured;
    expect(both.document?.title).toBe("Shelf idea");

    // A link with photos is still a note (the link kept in it), never Read later.
    const linked = await (await send("/v1/capture", "POST", { text: "https://example.com/chairs", photos: [a.ref, b.ref] })).json() as Captured;
    expect(linked.link).toBeUndefined();
    expect(linked.document?.title).toBe("2 photos");

    const { results } = await env.DB.prepare("SELECT title, body FROM documents ORDER BY created_at, rowid").all<{ title: string; body: string }>();
    expect(results.map((r) => r.body)).toEqual([
      `# Photo\n\n![](${a.url})\n`,
      `# Shelf idea\n\nThe oak one\n\n![](${a.url})\n\n![](${b.url})\n`,
      `# 2 photos\n\nhttps://example.com/chairs\n\n![](${a.url})\n\n![](${b.url})\n`,
    ]);
  });

  it("checks the photos it's given", async () => {
    const { send } = setup();
    const bad = await send("/v1/capture", "POST", { text: "x", photos: ["journal/../../etc.jpg"] });
    expect([bad.status, await bad.json()]).toEqual([400, { error: { code: "invalid", message: "photos must be refs from POST /v1/documents/photos" } }]);
    const gone = await send("/v1/capture", "POST", { photos: ["notes/01HZZZZZZZZZZZZZZZZZZZZZZZ-none.jpg"] });
    expect(gone.status).toBe(400);
    const nothing = await send("/v1/capture", "POST", { text: "  ", photos: [] });
    expect(await nothing.json()).toEqual({ error: { code: "invalid", message: "text is required (up to 20000 characters)" } });
    const tooMany = await send("/v1/capture", "POST", { photos: Array.from({ length: 21 }, () => "notes/x.jpg") });
    expect(tooMany.status).toBe(400);
  });

  it("copies a piece's photos to the public bucket when it's published, and only then", async () => {
    const { upload, send, env, pub } = setup();
    const photo = await (await upload(JPEG)).json() as Uploaded;
    const created = await (await send("/v1/documents", "POST", {
      kind: "writing", title: "Chairs", body: `# Chairs\n\nThe oak one.\n\n![The oak one](${photo.url})\n\n![old](https://media.example.test/blog/old.jpg)\n`,
    })).json() as { id: string; version: number };
    expect(pub.objects.size).toBe(0);

    const published = await (await send(`/v1/documents/${created.id}/publish`, "POST")).json() as { post_id: number; body: string; version: number };
    const publicKey = `blog/${photo.ref}`;
    expect(pub.objects.get(publicKey)?.data).toEqual(JPEG);
    expect(pub.objects.get(publicKey)?.cacheControl).toContain("public");
    const post = await env.DB.prepare("SELECT content, summary FROM posts WHERE id = ?").bind(published.post_id).first<{ content: string; summary: string }>();
    expect(post?.content).toBe(`The oak one.\n\n![The oak one](https://media.example.test/${publicKey})\n\n![old](https://media.example.test/blog/old.jpg)\n`);
    expect(post?.summary).toBe("The oak one.");
    // The note keeps its private address; the site's copy is the post's alone.
    expect(published.body).toContain(photo.url);

    // Saving the live piece again reuses the copy.
    await send(`/v1/documents/${created.id}`, "PUT", {
      kind: "writing", title: "Chairs", body: `# Chairs\n\nStill the oak one.\n\n![](${photo.url})\n`, version: published.version,
    });
    const again = await env.DB.prepare("SELECT content FROM posts WHERE id = ?").bind(published.post_id).first<{ content: string }>();
    expect(again?.content).toBe(`Still the oak one.\n\n![](https://media.example.test/${publicKey})\n`);
    expect(pub.objects.size).toBe(1);
  });

  it("finds private photos in Markdown, wherever the API lives", async () => {
    const md = "![a](https://api.anuragd.me/v1/documents/photos/01HZZZZZZZZZZZZZZZZZZZZZZZ-a.jpg)\n"
      + "![b](/v1/documents/photos/01HZZZZZZZZZZZZZZZZZZZZZZZ-b.png \"Title\")\n"
      + "![c](https://media.anuragd.me/blog/c.jpg) ![a again](https://api.anuragd.me/v1/documents/photos/01HZZZZZZZZZZZZZZZZZZZZZZZ-a.jpg)";
    expect(privatePhotoNames(md)).toEqual(["01HZZZZZZZZZZZZZZZZZZZZZZZ-a.jpg", "01HZZZZZZZZZZZZZZZZZZZZZZZ-b.png"]);
    // A photo whose original is gone keeps its address rather than failing the publish.
    const { env } = setup();
    expect(await publishNotePhotos(env, md)).toBe(md);
  });
});
