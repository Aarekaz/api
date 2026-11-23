// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
// @ts-expect-error same as above (node:sqlite is Node's built-in SQLite).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import documentsRoute, { captureRoute, searchRoute } from "../../routes/documents";
import syncStatusRoute from "../../routes/sync-status";
import linksRoute from "../../routes/links";
import { extractArticle, normalizeUrl } from "../../services/links";
import { pendingDocuments } from "../../services/backup";
import { classify, matchPost, splitFrontmatter, stripDatePrefix, toMarkdown, ulid } from "../../services/documents-core";

/** A real SQLite database behind the subset of the D1 API the code uses. */
function d1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    summary TEXT, content TEXT, tags_json TEXT, published_at TEXT, pinned INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
  db.exec(readFileSync("migrations/0025_documents.sql", "utf8"));
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

function app() {
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/documents", documentsRoute);
  root.route("/v1/search", searchRoute);
  root.route("/v1/capture", captureRoute);
  root.route("/v1/sync/status", syncStatusRoute);
  root.route("/v1/links", linksRoute);
  return root;
}

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("documents core", () => {
  it("classifies vault paths like the apps did", () => {
    expect(classify("Core/Journal/2026-11-23.md", {})).toMatchObject({ kind: "journal", visibility: "locked" });
    expect(classify("Writing/Drafts/x.md", {})).toMatchObject({ kind: "writing", status: "draft" });
    expect(classify("Writing/Published/Log.md", {})).toMatchObject({ kind: "note" });
    expect(classify("Finances/Plan.md", {})).toMatchObject({ visibility: "locked" });
    expect(classify("Core/Rules.md", { visibility: "public" })).toMatchObject({ kind: "note", visibility: "agents" });
  });

  it("matches writing to live posts by slug without the date, or by title", () => {
    const posts = [{ id: 1, slug: "the-model-is-easy-the-body-is-hard", title: "The Model Is Easy, the Body Is Hard" }];
    expect(matchPost({ slug: "2026-05-29-the-model-is-easy-the-body-is-hard", title: "x" }, posts)?.id).toBe(1);
    expect(matchPost({ slug: "other", title: "the model is easy the body is hard" }, posts)?.id).toBe(1);
    expect(stripDatePrefix("2026-05-29-a")).toBe("a");
  });

  it("splits frontmatter and writes it back", () => {
    const { frontmatter, body } = splitFrontmatter("---\nstatus: draft\ntags:\n  - a\n---\n# T\n");
    expect(frontmatter.status).toBe("draft");
    expect(body).toBe("# T\n");
    const md = toMarkdown({ id: "1", kind: "note", title: "T", body: "# T\n", visibility: "agents", status: null, frontmatter_json: JSON.stringify(frontmatter), updated_at: "2026-11-23" });
    expect(md.startsWith("---\nstatus: draft\ntags:\n  - a\nid: 1")).toBe(true);
  });

  it("makes sortable ids", () => {
    expect(ulid(1000) < ulid(2000)).toBe(true);
    expect(ulid()).toHaveLength(26);
  });
});

describe("documents routes", () => {
  it("creates, saves with versions, and refuses stale saves", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const created = await (await root.request("/v1/documents", json({ kind: "note", title: "Prompt Library", body: "# Prompt Library\n" }), env)).json() as { id: string; version: number; slug: string };
    expect(created.version).toBe(1);
    expect(created.slug).toBe("prompt-library");

    const saved = await root.request(`/v1/documents/${created.id}`, { ...json({ body: "new text", version: 1 }), method: "PUT" }, env);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { version: number }).version).toBe(2);

    const stale = await root.request(`/v1/documents/${created.id}`, { ...json({ body: "old tab", version: 1 }), method: "PUT" }, env);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { latest: { body: string } }).latest.body).toBe("new text");

    const versions = await (await root.request(`/v1/documents/${created.id}/versions`, {}, env)).json() as { versions: unknown[] };
    expect(versions.versions).toHaveLength(1);
  });

  it("searches titles and bodies", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    await root.request("/v1/documents", json({ title: "Getting Healthy and Fit", body: "Eat real food, train with intent." }), env);
    await root.request("/v1/documents", json({ title: "Agent tools", body: "Schemas are product work." }), env);
    const res = await (await root.request("/v1/search?q=trai", {}, env)).json() as { results: Array<{ title: string }> };
    expect(res.results.map((r) => r.title)).toEqual(["Getting Healthy and Fit"]);
  });

  it("publishes writing to the site's posts and unpublishes it", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const doc = await (await root.request("/v1/documents", json({ kind: "writing", title: "Agent tools as API design", body: "# Agent tools as API design\n\nSchemas are product work.\n" }), env)).json() as { id: string; status: string };
    expect(doc.status).toBe("draft");
    const published = await (await root.request(`/v1/documents/${doc.id}/publish`, { method: "POST" }, env)).json() as { status: string; post_id: number; visibility: string };
    expect(published).toMatchObject({ status: "published", visibility: "public" });
    const post = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(published.post_id).first<{ slug: string; content: string; summary: string; published_at: string }>();
    expect(post?.slug).toBe("agent-tools-as-api-design");
    expect(post?.content).toBe("Schemas are product work.\n");
    expect(post?.summary).toBe("Schemas are product work.");
    expect(post?.published_at).toBeTruthy();

    await root.request(`/v1/documents/${doc.id}/unpublish`, { method: "POST" }, env);
    const after = await env.DB.prepare("SELECT published_at FROM posts WHERE id = ?").bind(published.post_id).first<{ published_at: string | null }>();
    expect(after?.published_at).toBeNull();
  });

  it("captures each thought as its own note in Inbox", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    await root.request("/v1/capture", json({ text: "first idea" }), env);
    await root.request("/v1/capture", json({ text: "Gym plan\nsquat 3x5\nrow 3x8" }), env);
    const { results } = await env.DB.prepare("SELECT kind, folder, title, body FROM documents ORDER BY created_at").all<{ kind: string; folder: string; title: string; body: string }>();
    expect(results).toEqual([
      { kind: "note", folder: "Inbox", title: "first idea", body: "# first idea\n\n" },
      { kind: "note", folder: "Inbox", title: "Gym plan", body: "# Gym plan\n\nsquat 3x5\nrow 3x8\n" },
    ]);
  });

  it("changes what a page is, but never takes live writing off the site by accident", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const note = await (await root.request("/v1/documents", json({ kind: "note", title: "Idea", body: "# Idea\n\nText." }), env)).json() as { id: string };
    const put = (body: unknown) => root.request(`/v1/documents/${note.id}`, { ...json(body), method: "PUT" }, env);

    const writing = await (await put({ kind: "writing", version: 1 })).json() as { kind: string; status: string; version: number };
    expect(writing).toMatchObject({ kind: "writing", status: "draft" });

    await root.request(`/v1/documents/${note.id}/publish`, { method: "POST" }, env);
    const refused = await put({ kind: "note", version: 3 });
    expect(refused.status).toBe(400);

    await root.request(`/v1/documents/${note.id}/unpublish`, { method: "POST" }, env);
    const back = await (await put({ kind: "journal", version: 4 })).json() as { kind: string; status: string | null; visibility: string };
    expect(back).toMatchObject({ kind: "journal", status: null, visibility: "locked" });

    const again = await (await put({ kind: "note", version: 5 })).json() as { kind: string; visibility: string };
    expect(again).toMatchObject({ kind: "note", visibility: "private" });
  });

  it("soft deletes and lists changes since a time", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const a = await (await root.request("/v1/documents", json({ title: "A" }), env)).json() as { id: string };
    await root.request(`/v1/documents/${a.id}`, { method: "DELETE" }, env);
    const list = await (await root.request("/v1/documents", {}, env)).json() as { documents: unknown[] };
    expect(list.documents).toHaveLength(0);
    const withDeleted = await (await root.request("/v1/documents?include_deleted=1", {}, env)).json() as { documents: Array<{ deleted_at?: string }> };
    expect(withDeleted.documents[0].deleted_at).toBeTruthy();
  });

  it("reports sync status even when some sources aren't set up", async () => {
    const env = { DB: d1() } as Env;
    const res = await (await app().request("/v1/sync/status", {}, env)).json() as { sources: Array<{ id: string; status: string }> };
    expect(res.sources.map((s) => s.id)).toEqual(["documents", "whoop", "wakatime", "github", "spotify", "backup"]);
    expect(res.sources.find((s) => s.id === "backup")?.status).toBe("pending");
  });
});

describe("vault backup", () => {
  it("does not skip documents that share an updated_at across batches", async () => {
    const DB = d1();
    const env = { DB } as unknown as Env;
    const stamp = "2026-11-23T02:48:09.000Z";
    for (let i = 0; i < 5; i++) {
      await DB.prepare(
        "INSERT INTO documents (id, kind, folder, title, slug, body, visibility, created_at, updated_at, version) VALUES (?, 'note', '', ?, ?, '', 'private', ?, ?, 1)",
      ).bind(`doc${i}`, `Note ${i}`, `note-${i}`, stamp, stamp).run();
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 5; round++) {
      const batch = await pendingDocuments(env, cursor, 2);
      if (batch.length === 0) break;
      seen.push(...batch.map((d) => d.id));
      cursor = `${batch[batch.length - 1].updated_at}|${batch[batch.length - 1].id}`;
    }
    expect(seen).toEqual(["doc0", "doc1", "doc2", "doc3", "doc4"]);
  });

  it("starts over from a cursor written before ids were added", async () => {
    const DB = d1();
    const env = { DB } as unknown as Env;
    await DB.prepare(
      "INSERT INTO documents (id, kind, folder, title, slug, body, visibility, created_at, updated_at, version) VALUES ('a', 'note', '', 'A', 'a', '', 'private', ?, ?, 1)",
    ).bind("2026-11-23T02:48:09.000Z", "2026-11-23T02:48:09.000Z").run();
    expect((await pendingDocuments(env, "2026-11-23T03:39:26.000Z", 10)).map((d) => d.id)).toEqual(["a"]);
  });
});

const PAGE = `<html><head><title>Ignored | Site</title>
<meta property="og:title" content="Why Agents Need Schemas">
<meta property="og:site_name" content="Field Notes">
<meta name="description" content="Tools are product work &amp; deserve care.">
</head><body><nav><a>Home</a></nav><script>var x = "<p>no</p>";</script>
<article><h1>Why Agents Need Schemas</h1><p>First <em>real</em> paragraph that is long enough to count as text.</p>
<ul><li>One</li><li>Two</li></ul><blockquote><p>Quoted line</p></blockquote><pre><code>let a = 1 &lt; 2</code></pre></article>
<footer><p>Copyright</p></footer></body></html>`;

describe("read later", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("extracts the readable part of a page as Markdown", () => {
    const a = extractArticle(PAGE, "https://www.example.com/post");
    expect(a.title).toBe("Why Agents Need Schemas");
    expect(a.site).toBe("Field Notes");
    expect(a.excerpt).toBe("Tools are product work & deserve care.");
    expect(a.markdown).toBe("First real paragraph that is long enough to count as text.\n\n- One\n\n- Two\n\n> Quoted line\n\n```\nlet a = 1 < 2\n```");
    expect(a.markdown).not.toContain("Copyright");
  });

  it("cleans URLs and refuses other schemes", () => {
    expect(normalizeUrl("https://a.com/x?utm_source=t&id=2#top")).toBe("https://a.com/x?id=2");
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow();
  });

  it("saves a link once, fetches its text, and tracks reading", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })));
    const env = { DB: d1() } as Env;
    const root = app();
    const saved = await root.request("/v1/links", json({ url: "https://example.com/post?utm_medium=x" }), env);
    expect(saved.status).toBe(201);
    const link = await saved.json() as { id: string; title: string; body: string; reading_minutes: number; url: string; fetch_error: string | null };
    expect(link).toMatchObject({ title: "Why Agents Need Schemas", url: "https://example.com/post", fetch_error: null, reading_minutes: 1 });
    expect(link.body).toContain("First real paragraph");

    const again = await (await root.request("/v1/links", json({ url: "https://example.com/post" }), env)).json() as { id: string };
    expect(again.id).toBe(link.id);

    await root.request(`/v1/links/${link.id}/read`, { method: "POST" }, env);
    const unread = await (await root.request("/v1/links?state=unread", {}, env)).json() as { links: unknown[] };
    const read = await (await root.request("/v1/links?state=read", {}, env)).json() as { links: unknown[] };
    expect(unread.links).toHaveLength(0);
    expect(read.links).toHaveLength(1);

    const found = await (await root.request("/v1/search?q=schemas", {}, env)).json() as { results: Array<{ kind: string }> };
    expect(found.results[0].kind).toBe("link");
  });

  it("records a failed fetch instead of failing the save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const env = { DB: d1() } as Env;
    const link = await (await app().request("/v1/links", json({ url: "https://paywalled.com/a" }), env)).json() as { title: string; fetch_error: string };
    expect(link.title).toBe("paywalled.com");
    expect(link.fetch_error).toBe("The site answered 403");
  });

  it("captures a bare URL as a link, not a Dump line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE, { headers: { "content-type": "text/html" } })));
    const env = { DB: d1() } as Env;
    const res = await (await app().request("/v1/capture", json({ text: "https://example.com/post" }), env)).json() as { link: { title: string } };
    expect(res.link.title).toBe("Why Agents Need Schemas");
    expect(await env.DB.prepare("SELECT 1 FROM documents WHERE source = 'vault:Dump.md'").first()).toBeNull();
  });
});
