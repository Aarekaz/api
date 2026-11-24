import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import { pagesFor, siteRefresh } from "../../middleware/site-refresh";

/** Only what the middleware reads: a post's slug by id. */
const db = {
  prepare: () => ({ bind: () => ({ first: async () => ({ slug: "tembo" }) }) }),
} as unknown as D1Database;

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.use("/v1/*", siteRefresh);
  a.put("/v1/now", (c) => c.json({ ok: true }));
  a.post("/v1/shelf", (c) => c.json({ id: 1 }, 201));
  a.post("/v1/uses", (c) => c.json({ error: { code: "bad", message: "no" } }, 400));
  a.put("/v1/documents/:id", (c) => c.json({ kind: c.req.query("kind"), status: c.req.query("status"), post_id: 7 }));
  a.post("/v1/documents/:id/publish", (c) => c.json({ kind: "writing", status: "published", post_id: 7 }));
  a.get("/v1/projects", (c) => c.json([]));
  return a;
}

const env = (token?: string) => ({ DB: db, REVALIDATE_TOKEN: token } as unknown as Env);

function stubFetch() {
  const calls: Array<{ url: string; paths: string[]; auth: string | null }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, paths: JSON.parse(String(init.body)).paths, auth: new Headers(init.headers).get("authorization") });
    return new Response("{}", { status: 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("site refresh", () => {
  it("maps writes to the pages that show them", () => {
    expect(pagesFor("PUT", "/v1/now")).toEqual(["/now"]);
    expect(pagesFor("PATCH", "/v1/site/profile")).toEqual(["/", "/resume"]);
    expect(pagesFor("DELETE", "/v1/projects/3")).toEqual(["/", "/projects"]);
    expect(pagesFor("POST", "/v1/photos/upload-presigned")).toEqual(["/photography"]);
    expect(pagesFor("PATCH", "/v1/shelf/9/")).toContain("/shelf/books");
    expect(pagesFor("POST", "/v1/experience")).toEqual(["/resume"]);
    expect(pagesFor("POST", "/v1/documents/abc/publish")).toEqual(["/", "/blog"]);
    // Private things and reads never touch the site.
    expect(pagesFor("PUT", "/v1/documents/abc")).toEqual([]);
    expect(pagesFor("POST", "/v1/journal")).toEqual([]);
    expect(pagesFor("POST", "/v1/nowhere")).toEqual([]);
    expect(pagesFor("GET", "/v1/now")).toEqual([]);
  });

  it("calls the site's revalidate route with its token", async () => {
    const calls = stubFetch();
    const res = await app().request("/v1/now", { method: "PUT" }, env("secret"));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: "https://www.anuragd.me/api/revalidate", paths: ["/now"], auth: "Bearer secret" }]);
  });

  it("does nothing without a token, on errors, or on reads", async () => {
    const calls = stubFetch();
    await app().request("/v1/shelf", { method: "POST" }, env());
    await app().request("/v1/uses", { method: "POST" }, env("secret"));
    await app().request("/v1/projects", {}, env("secret"));
    expect(calls).toEqual([]);
  });

  it("refreshes a live post's own page when it's saved, and nothing for private notes", async () => {
    const calls = stubFetch();
    await app().request("/v1/documents/a?kind=writing&status=published", { method: "PUT" }, env("secret"));
    await app().request("/v1/documents/b?kind=note&status=private", { method: "PUT" }, env("secret"));
    await app().request("/v1/documents/c?kind=writing&status=draft", { method: "PUT" }, env("secret"));
    expect(calls.map((c) => c.paths)).toEqual([["/blog/tembo", "/blog/tembo.md"]]);
  });

  it("refreshes the blog list and home on publish", async () => {
    const calls = stubFetch();
    await app().request("/v1/documents/a/publish", { method: "POST" }, env("secret"));
    expect(calls[0].paths).toEqual(["/", "/blog", "/blog/tembo", "/blog/tembo.md"]);
  });

  it("never fails the request when the site is down", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    const res = await app().request("/v1/now", { method: "PUT" }, env("secret"));
    expect(res.status).toBe(200);
  });
});
