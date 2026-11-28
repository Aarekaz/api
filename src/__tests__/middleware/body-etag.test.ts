import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import { testD1 } from "../helpers/d1";
import { bodyEtag, strongTag, underBodyEtag } from "../../middleware/body-etag";
import documentsRoute from "../../routes/documents";
import postsRoute from "../../routes/posts";

function stubApp() {
  const app = new Hono();
  app.use("/v1/*", bodyEtag);
  let count = 3;
  app.get("/v1/links", (c) => c.json({ items: Array.from({ length: count }, (_, i) => ({ id: i })), next_cursor: null }));
  app.post("/v1/links", (c) => { count++; return c.json({ ok: true }, 201); });
  app.get("/v1/links/missing", (c) => c.json({ error: { code: "not_found", message: "No" } }, 404));
  app.get("/v1/documents/photos/x", () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } }));
  app.get("/v1/shelf/tagged", (c) => { c.header("ETag", '"mine"'); return c.json({ ok: true }); });
  app.get("/v1/music/history", (c) => c.json({ items: [] }));
  return app;
}

describe("strong ETags from the body", () => {
  it("tags a 200 JSON GET and answers 304 to a match, until the body changes", async () => {
    const app = stubApp();
    const first = await app.request("/v1/links");
    const tag = first.headers.get("ETag")!;
    expect(tag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
    const body = await first.text();
    expect(tag).toBe(await strongTag(new TextEncoder().encode(body)));

    const again = await app.request("/v1/links", { headers: { "If-None-Match": tag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("ETag")).toBe(tag);
    // A tag the edge weakened, or one in a list, still matches.
    expect((await app.request("/v1/links", { headers: { "If-None-Match": `"other", W/${tag}` } })).status).toBe(304);

    await app.request("/v1/links", { method: "POST" });
    const changed = await app.request("/v1/links", { headers: { "If-None-Match": tag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(tag);
    expect(((await changed.json()) as { items: unknown[] }).items).toHaveLength(4);
  });

  it("leaves errors, writes, images, tagged replies and other routes alone", async () => {
    const app = stubApp();
    expect((await app.request("/v1/links/missing")).headers.get("ETag")).toBeNull();
    expect((await app.request("/v1/links", { method: "POST" })).headers.get("ETag")).toBeNull();
    expect((await app.request("/v1/documents/photos/x")).headers.get("ETag")).toBeNull();
    expect((await app.request("/v1/shelf/tagged")).headers.get("ETag")).toBe('"mine"');
    expect((await app.request("/v1/music/history")).headers.get("ETag")).toBeNull();
  });

  it("covers documents, links, journal, shelf and posts, and nothing that only shares a prefix", () => {
    for (const path of ["/v1/documents", "/v1/documents/abc", "/v1/links", "/v1/journal", "/v1/shelf", "/v1/shelf/diary", "/v1/posts"]) {
      expect(underBodyEtag(path)).toBe(true);
    }
    for (const path of ["/v1/postscript", "/v1/visits/places", "/v1/projects"]) expect(underBodyEtag(path)).toBe(false);
  });

  it("works on the real documents and posts lists, keeping their bodies", async () => {
    const { DB } = testD1({ migrations: "all" });
    const env = { DB } as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.use("/v1/*", bodyEtag);
    app.route("/v1/documents", documentsRoute);
    app.route("/v1/posts", postsRoute);
    await app.request("/v1/documents", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "note", title: "One", body: "# One\n" }),
    }, env);
    const list = await app.request("/v1/documents", {}, env);
    const tag = list.headers.get("ETag")!;
    expect(((await list.json()) as { items: Array<{ title: string }> }).items.map((d) => d.title)).toEqual(["One"]);
    // server_time differs on every reply, so the list's tag leaves it out and is weak.
    expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await app.request("/v1/documents", { headers: { "If-None-Match": tag } }, env);
    expect(again.status).toBe(304);
    await app.request("/v1/documents", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "note", title: "Two", body: "# Two\n" }),
    }, env);
    expect((await app.request("/v1/documents", { headers: { "If-None-Match": tag } }, env)).status).toBe(200);

    const posts = await app.request("/v1/posts", {}, env);
    expect(posts.status).toBe(200);
    const postsTag = posts.headers.get("ETag")!;
    expect(postsTag).toBeTruthy();
    const postsBody = await posts.text();
    expect((await app.request("/v1/posts", { headers: { "If-None-Match": postsTag } }, env)).status).toBe(304);
    // Without If-None-Match the body is exactly what the route sent.
    expect(await (await app.request("/v1/posts", {}, env)).text()).toBe(postsBody);
  });
});
