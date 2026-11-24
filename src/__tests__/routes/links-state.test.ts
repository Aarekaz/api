// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
// @ts-expect-error same as above (node:sqlite is Node's built-in SQLite).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import linksRoute from "../../routes/links";
import highlightsRoute from "../../routes/highlights";
import { linkKind } from "../../services/links";

// Inbox / Archive, synced reading progress (last write wins), a note per
// article, tags, and the one error shape, on a real SQLite database.

function d1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    summary TEXT, content TEXT, tags_json TEXT, published_at TEXT, pinned INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
  db.exec(readFileSync("migrations/0025_documents.sql", "utf8"));
  db.exec(readFileSync("migrations/0026_highlights.sql", "utf8"));
  db.exec(readFileSync("migrations/0036_links_state.sql", "utf8"));
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async run() {
      const info = db.prepare(sql).run(...args) as { changes: number; lastInsertRowid: number };
      return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
    async first<T>() { return (db.prepare(sql).get(...args) as T) ?? null; },
    async all<T>() { return { results: db.prepare(sql).all(...args) as T[] }; },
  });
  return {
    prepare: (sql: string) => statement(sql),
    async batch(list: Array<{ run: () => Promise<unknown> }>) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

const PAGE = `<html><head><meta property="og:title" content="On Reading Slowly"><meta property="og:site_name" content="Field Notes"></head>
<body><article><p>The first paragraph is long enough to count as the start of a real article you would read.</p>
<p>The second paragraph keeps going so there is more than one block to place a reader in.</p></article></body></html>`;

type Link = {
  id: string; state: string; archived_at: string | null; read_at: string | null; kind: string;
  progress: number; progress_anchor: string | null; progress_updated_at: string | null; progress_device: string | null;
  opened_at: string | null; note: string | null; note_updated_at: string | null; tags: string[]; title: string; version: number;
};

function setup() {
  const env = { DB: d1() } as Env;
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/links", linksRoute);
  root.route("/v1/highlights", highlightsRoute);
  const send = (path: string, method = "GET", body?: unknown) =>
    root.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
  const save = async (url: string) => (await (await send("/v1/links", "POST", { url })).json()) as Link;
  return { env, send, save };
}

describe("links: inbox and archive", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE, { headers: { "content-type": "text/html" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lands every link in the Inbox, with the new fields and the old ones", async () => {
    const { save } = setup();
    const link = await save("https://example.com/slow");
    expect(link).toMatchObject({
      state: "inbox", archived_at: null, read_at: null, kind: "article", progress: 0, progress_anchor: null,
      progress_updated_at: null, opened_at: null, note: null, tags: [], title: "On Reading Slowly",
    });
    // Everything older clients read is still there.
    for (const key of ["url", "site", "excerpt", "reading_minutes", "fetched_at", "image_url", "icon_url", "starred_at", "fetch_error", "visibility", "created_at", "updated_at", "version", "body"]) {
      expect(link).toHaveProperty(key);
    }
  });

  it("archives and unarchives, keeping read_at in step and the first finish time", async () => {
    const { send, save } = setup();
    const link = await save("https://example.com/slow");
    const archived = await (await send(`/v1/links/${link.id}/archive`, "POST")).json() as Link;
    expect(archived.state).toBe("archived");
    expect(archived.archived_at).toBe(archived.read_at);
    expect(archived.read_at).toBeTruthy();

    await new Promise((r) => setTimeout(r, 5));
    const again = await (await send(`/v1/links/${link.id}/read`, "POST")).json() as Link;
    expect(again.read_at).toBe(archived.read_at);

    const inbox = await (await send("/v1/links?state=inbox")).json() as { links: Link[] };
    const archive = await (await send("/v1/links?state=archived")).json() as { links: Link[] };
    expect(inbox.links).toHaveLength(0);
    expect(archive.links.map((l) => l.id)).toEqual([link.id]);

    const back = await (await send(`/v1/links/${link.id}`, "PATCH", { state: "inbox" })).json() as Link;
    expect(back).toMatchObject({ state: "inbox", read_at: null, archived_at: null });
    const viaPatch = await (await send(`/v1/links/${link.id}`, "PATCH", { state: "archived" })).json() as Link;
    expect(viaPatch.state).toBe("archived");
    const unarchived = await (await send(`/v1/links/${link.id}/unarchive`, "POST")).json() as Link;
    expect(unarchived.state).toBe("inbox");
  });

  it("tells videos, PDFs and posts from articles", () => {
    expect(linkKind("https://www.youtube.com/watch?v=x")).toBe("video");
    expect(linkKind("https://youtu.be/x")).toBe("video");
    expect(linkKind("https://example.com/paper.PDF")).toBe("pdf");
    expect(linkKind("https://example.com/download", "Not a web page (application/pdf)")).toBe("pdf");
    expect(linkKind("https://x.com/someone/status/1")).toBe("post");
    expect(linkKind("https://mobile.twitter.com/someone/status/1")).toBe("post");
    expect(linkKind("https://example.com/essay")).toBe("article");
  });
});

describe("links: reading progress", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE, { headers: { "content-type": "text/html" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saves progress with an anchor, and the latest reading wins", async () => {
    const { send, save } = setup();
    const link = await save("https://example.com/slow");
    const put = (body: unknown) => send(`/v1/links/${link.id}/progress`, "PUT", body);

    const phone = await (await put({ progress: 0.4, anchor: "b3:0.5", updated_at: "2026-11-01T10:00:00.000Z", device: "iPhone" })).json() as Record<string, unknown>;
    expect(phone).toMatchObject({ applied: true, progress: 0.4, progress_anchor: "b3:0.5", progress_updated_at: "2026-11-01T10:00:00.000Z", progress_device: "iPhone", opened_at: "2026-11-01T10:00:00.000Z" });

    // The Mac read further, later.
    const mac = await (await put({ progress: 0.7, anchor: "b5:0.1", updated_at: "2026-11-01T11:00:00+00:00", device: "Mac" })).json() as Record<string, unknown>;
    expect(mac).toMatchObject({ applied: true, progress: 0.7, progress_updated_at: "2026-11-01T11:00:00.000Z", progress_device: "Mac" });

    // The phone comes back online with an older position: it doesn't pull the Mac back.
    const stale = await (await put({ progress: 0.45, anchor: "b3:0.9", updated_at: "2026-11-01T10:05:00.000Z", device: "iPhone" })).json() as Record<string, unknown>;
    expect(stale).toMatchObject({ applied: false, progress: 0.7, progress_anchor: "b5:0.1", progress_device: "Mac" });

    // Going back up is fine when it's newer: last write wins, not furthest.
    const reread = await (await put({ progress: 0.1, anchor: "b0:0", updated_at: "2026-11-01T12:00:00.000Z" })).json() as Record<string, unknown>;
    expect(reread).toMatchObject({ applied: true, progress: 0.1, opened_at: "2026-11-01T10:00:00.000Z" });

    const got = await (await send(`/v1/links/${link.id}/progress`)).json() as Record<string, unknown>;
    expect(got).toMatchObject({ progress: 0.1, progress_anchor: "b0:0" });
    const listed = (await (await send("/v1/links")).json() as { links: Link[] }).links[0];
    expect(listed).toMatchObject({ progress: 0.1, progress_anchor: "b0:0", progress_updated_at: "2026-11-01T12:00:00.000Z" });
  });

  it("treats a time from the future as now", async () => {
    const { send, save } = setup();
    const link = await save("https://example.com/slow");
    const res = await (await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.5, updated_at: "2099-01-01T00:00:00.000Z" })).json() as { progress_updated_at: string };
    expect(Date.parse(res.progress_updated_at)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("refuses bad progress with the one error shape", async () => {
    const { send, save } = setup();
    const link = await save("https://example.com/slow");
    const tooFar = await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 1.5 });
    expect(tooFar.status).toBe(400);
    const body = await tooFar.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid");
    expect(body.error.message).toContain("progress");
    const missing = await send("/v1/links/nope/progress", "PUT", { progress: 0.2 });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "Link not found" } });
    const junk = await send(`/v1/links/${link.id}/progress`, "PUT", { progress: "half" });
    expect(junk.status).toBe(400);
  });
});

describe("links: notes and tags", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE, { headers: { "content-type": "text/html" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a note per article and clears it", async () => {
    const { send, save } = setup();
    const link = await save("https://example.com/slow");
    const noted = await (await send(`/v1/links/${link.id}`, "PATCH", { note: "  Read this again in spring.  " })).json() as Link;
    expect(noted.note).toBe("Read this again in spring.");
    expect(noted.note_updated_at).toBeTruthy();
    expect(noted.version).toBe(link.version);   // a note isn't a new version of the article
    const cleared = await (await send(`/v1/links/${link.id}`, "PATCH", { note: "" })).json() as Link;
    expect(cleared.note).toBeNull();
    // Progress and the note share a row without overwriting each other.
    await send(`/v1/links/${link.id}`, "PATCH", { note: "kept" });
    await send(`/v1/links/${link.id}/progress`, "PUT", { progress: 0.3 });
    const both = await (await send(`/v1/links/${link.id}`)).json() as Link;
    expect(both).toMatchObject({ note: "kept", progress: 0.3 });
  });

  it("tags, filters by tag and counts tags", async () => {
    const { send, save } = setup();
    const a = await save("https://example.com/a");
    const b = await save("https://example.com/b");
    await send(`/v1/links/${a.id}`, "PATCH", { tags: ["#Design", "agents"] });
    await send(`/v1/links/${b.id}`, "PATCH", { tags: ["design"] });
    await send(`/v1/links/${b.id}/archive`, "POST");

    const design = await (await send("/v1/links?tag=design")).json() as { links: Link[] };
    expect(design.links.map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
    const inboxDesign = await (await send("/v1/links?state=inbox&tag=Design")).json() as { links: Link[] };
    expect(inboxDesign.links.map((l) => l.id)).toEqual([a.id]);

    const tags = await (await send("/v1/links/tags")).json() as { items: Array<{ tag: string; count: number; inbox: number }> };
    expect(tags.items).toEqual([{ tag: "design", count: 2, inbox: 1 }, { tag: "agents", count: 1, inbox: 1 }]);

    const bad = await send(`/v1/links/${a.id}`, "PATCH", { tags: "design" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid");
  });

  it("uses the one error shape across links and highlights", async () => {
    const { send } = setup();
    expect(await (await send("/v1/links/nope")).json()).toEqual({ error: { code: "not_found", message: "Link not found" } });
    const noUrl = await send("/v1/links", "POST", {});
    expect(noUrl.status).toBe(400);
    expect(((await noUrl.json()) as { error: { code: string } }).error.code).toBe("invalid");
    const badUrl = await send("/v1/links", "POST", { url: "javascript:alert(1)" });
    expect(badUrl.status).toBe(400);
    const noDoc = await send("/v1/highlights", "POST", { document_id: "nope", text: "x" });
    expect(noDoc.status).toBe(404);
    expect(((await noDoc.json()) as { error: { code: string } }).error.code).toBe("not_found");
    const noText = await send("/v1/highlights", "POST", { document_id: "nope", text: "  " });
    expect(noText.status).toBe(400);
  });

  it("returns highlights with their site, and only changes what a patch sends", async () => {
    const { send, save } = setup();
    const link = await save("https://example.com/slow");
    const h = await (await send("/v1/highlights", "POST", { document_id: link.id, text: "first paragraph", note: "keep", color: "green" })).json() as { id: string; site: string };
    expect(h.site).toBe("Field Notes");
    const recoloured = await (await send(`/v1/highlights/${h.id}`, "PATCH", { color: "blue" })).json() as { note: string; color: string };
    expect(recoloured).toMatchObject({ note: "keep", color: "blue" });
    const unnoted = await (await send(`/v1/highlights/${h.id}`, "PATCH", { note: null })).json() as { note: string | null; color: string };
    expect(unnoted).toMatchObject({ note: null, color: "blue" });
  });
});
