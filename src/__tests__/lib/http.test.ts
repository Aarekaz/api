import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { body, cursorFrom, encodeCursor, fail, failWith, HttpError, list, notModified, page, parse } from "../../lib/http";
import { DocumentError } from "../../services/documents";
import { SectionError } from "../../services/sections";

const app = new Hono();
app.get("/fail", (c) => fail(c, 404, "Nothing here"));
app.get("/details", (c) => fail(c, 400, "Bad", { details: { field: "x" }, extra: { latest: null } }));
app.get("/throw/:kind", (c) => {
  const kind = c.req.param("kind");
  const error = kind === "http" ? new HttpError(422, "Can't read that", "unprocessable")
    : kind === "zod" ? z.object({ n: z.number() }).safeParse({ n: "x" }).error
    : kind === "document" ? new DocumentError("Document not found", 404)
    : kind === "section" ? new SectionError("Already there", 409, "exists")
    : new Error("boom");
  return failWith(c, error, "Test request");
});
app.get("/cursor", (c) => {
  try { return c.json({ values: cursorFrom(c, 2) }); } catch (error) { return failWith(c, error); }
});
app.post("/body", async (c) => {
  try { return c.json(await body(c, z.object({ name: z.string() }))); } catch (error) { return failWith(c, error); }
});
app.get("/list", (c) => list(c, "links", [1, 2], "abc", { total: 2 }));
app.get("/tagged", (c) => notModified(c, 'W/"places-3-x"') ?? c.json({ ok: true }));

const json = async (path: string, init?: RequestInit) => {
  const res = await app.request(path, init);
  return { status: res.status, body: res.status === 304 ? null : await res.json() as Record<string, unknown>, res };
};

describe("lib/http", () => {
  it("answers errors as { error: { code, message } }", async () => {
    expect(await json("/fail")).toMatchObject({ status: 404, body: { error: { code: "not_found", message: "Nothing here" } } });
    expect((await json("/details")).body).toEqual({ latest: null, error: { code: "invalid", message: "Bad", details: { field: "x" } } });
  });

  it("maps what a handler throws", async () => {
    expect(await json("/throw/http")).toMatchObject({ status: 422, body: { error: { code: "unprocessable", message: "Can't read that" } } });
    expect(await json("/throw/zod")).toMatchObject({ status: 400, body: { error: { code: "invalid" } } });
    expect(await json("/throw/document")).toMatchObject({ status: 404, body: { error: { code: "not_found", message: "Document not found" } } });
    expect(await json("/throw/section")).toMatchObject({ status: 409, body: { error: { code: "exists" } } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await json("/throw/other")).toEqual(expect.objectContaining({ status: 500, body: { error: { code: "server", message: "Test request failed" } } }));
    quiet.mockRestore();
  });

  it("reads and checks a JSON body", async () => {
    const post = (b: string) => json("/body", { method: "POST", body: b, headers: { "Content-Type": "application/json" } });
    expect((await post('{"name":"a"}')).body).toEqual({ name: "a" });
    expect(await post("{")).toMatchObject({ status: 400, body: { error: { message: "Invalid JSON" } } });
    expect(await post('{"name":1}')).toMatchObject({ status: 400, body: { error: { code: "invalid" } } });
    expect(() => parse(z.number(), "x")).toThrow(HttpError);
  });

  it("round-trips cursors, unicode included, and refuses made-up ones", async () => {
    const cursor = encodeCursor(["2026-11-25T01:02:03.000Z", "café ☕"]);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await json(`/cursor?cursor=${cursor}`)).body).toEqual({ values: ["2026-11-25T01:02:03.000Z", "café ☕"] });
    expect((await json("/cursor")).body).toEqual({ values: null });
    expect((await json(`/cursor?cursor=${encodeCursor([1])}`)).status).toBe(400);
    expect((await json("/cursor?cursor=***")).status).toBe(400);
  });

  it("pages rows fetched one past the limit", () => {
    const rows = [{ id: 3 }, { id: 2 }, { id: 1 }];
    expect(page(rows, 2, (r) => [r.id])).toEqual({ items: [{ id: 3 }, { id: 2 }], next_cursor: encodeCursor([2]) });
    expect(page(rows, 3, (r) => [r.id])).toEqual({ items: rows, next_cursor: null });
  });

  it("lists items and next_cursor, without the old named key", async () => {
    expect((await json("/list")).body).toEqual({ total: 2, items: [1, 2], next_cursor: "abc" });
    const off = await app.request("/list", {}, { LEGACY_LIST_KEYS: "off" });
    expect(await off.json()).toEqual({ total: 2, items: [1, 2], next_cursor: "abc" });
  });

  it("keeps the named key beside items while LEGACY_LIST_KEYS is on", async () => {
    const res = await app.request("/list", {}, { LEGACY_LIST_KEYS: "on" });
    expect(await res.json()).toEqual({ links: [1, 2], total: 2, items: [1, 2], next_cursor: "abc" });
  });

  it("answers 304 to a matching If-None-Match, weak or strong", async () => {
    const first = await json("/tagged");
    expect(first.res.headers.get("ETag")).toBe('W/"places-3-x"');
    expect(first.res.headers.get("Cache-Control")).toBe("private, no-cache");
    for (const sent of ['W/"places-3-x"', '"places-3-x"', '"other", W/"places-3-x"', "*"]) {
      expect((await json("/tagged", { headers: { "If-None-Match": sent } })).status).toBe(304);
    }
    expect((await json("/tagged", { headers: { "If-None-Match": 'W/"places-2-x"' } })).status).toBe(200);
  });
});
