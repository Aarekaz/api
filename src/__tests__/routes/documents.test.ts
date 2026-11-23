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
import highlightsRoute from "../../routes/highlights";
import visitsRoute, { findTrips } from "../../routes/visits";
import { createMusicRoute } from "../../routes/music";
import { playsFrom, savePlays } from "../../services/spotify/history";
import { extractArticle, normalizeUrl } from "../../services/links";
import { pendingDocuments } from "../../services/backup";
import { classify, matchPost, splitFrontmatter, stripDatePrefix, toMarkdown, ulid } from "../../services/documents-core";

/** A real SQLite database behind the subset of the D1 API the code uses. */
function d1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    summary TEXT, content TEXT, tags_json TEXT, published_at TEXT, pinned INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
  db.exec(readFileSync("migrations/0025_documents.sql", "utf8"));
  db.exec(readFileSync("migrations/0026_highlights.sql", "utf8"));
  db.exec(readFileSync("migrations/0027_visits.sql", "utf8"));
  db.exec(readFileSync("migrations/0028_place_names.sql", "utf8"));
  db.exec(readFileSync("migrations/0029_journeys.sql", "utf8"));
  db.exec(readFileSync("migrations/0030_music_plays.sql", "utf8"));
  db.exec(`CREATE TABLE location_history (id INTEGER PRIMARY KEY AUTOINCREMENT, latitude REAL NOT NULL, longitude REAL NOT NULL,
    altitude REAL, accuracy REAL, speed REAL, heading REAL, recorded_at TEXT NOT NULL, address TEXT, city TEXT, state TEXT,
    country TEXT, postal_code TEXT, label TEXT, notes TEXT, source TEXT, created_at TEXT NOT NULL, updated_at TEXT);`);
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
  root.route("/v1/highlights", highlightsRoute);
  root.route("/v1/visits", visitsRoute);
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
<meta property="og:image" content="/img/lead.jpg">
<link rel="icon" href="https://example.com/favicon.png">
</head><body><nav><a>Home</a></nav><script>var x = "<p>no</p>";</script>
<article><h1>Why Agents Need Schemas</h1><p>First <em>real</em> paragraph that is long enough to count as text.</p>
<figure><img src="/img/chart.png" alt="A chart"><figcaption>Fig 1</figcaption></figure><img src="/pixel.gif" width="1"><ul><li>One</li><li>Two</li></ul><blockquote><p>Quoted line</p></blockquote><pre><code>let a = 1 &lt; 2</code></pre></article>
<footer><p>Copyright</p></footer></body></html>`;

describe("read later", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("extracts the readable part of a page as Markdown", () => {
    const a = extractArticle(PAGE, "https://www.example.com/post");
    expect(a.title).toBe("Why Agents Need Schemas");
    expect(a.site).toBe("Field Notes");
    expect(a.excerpt).toBe("Tools are product work & deserve care.");
    expect(a.markdown).toBe("First *real* paragraph that is long enough to count as text.\n\n![A chart](https://www.example.com/img/chart.png)\n\n- One\n\n- Two\n\n> Quoted line\n\n```\nlet a = 1 < 2\n```");
    expect(a.image).toBe("https://www.example.com/img/lead.jpg");
    expect(a.icon).toBe("https://example.com/favicon.png");
    expect(a.markdown).not.toContain("Copyright");
  });

  it("keeps bold, italics and links in the text", () => {
    const html = `<article><p>In his mind, <strong>there isn't much competition</strong>, as <a href="/people/aaron">Aaron Francis</a> said on <em>Mostly Technical</em>.</p></article>`;
    expect(extractArticle(html, "https://justinjackson.ca/post").markdown)
      .toBe("In his mind, **there isn't much competition**, as [Aaron Francis](https://justinjackson.ca/people/aaron) said on *Mostly Technical*.");
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
    expect(link.body).toContain("First *real* paragraph");

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

describe("highlights and link state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("highlights a passage with a note, lists, edits and removes it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE, { headers: { "content-type": "text/html" } })));
    const env = { DB: d1() } as Env;
    const root = app();
    const link = await (await root.request("/v1/links", json({ url: "https://example.com/post" }), env)).json() as { id: string };

    const created = await root.request("/v1/highlights", json({ document_id: link.id, text: "real paragraph", prefix: "First ", suffix: " that", note: "keep" }), env);
    expect(created.status).toBe(201);
    const h = await created.json() as { id: string; title: string; url: string; note: string };
    expect(h).toMatchObject({ title: "Why Agents Need Schemas", url: "https://example.com/post", note: "keep" });

    const edited = await (await root.request(`/v1/highlights/${h.id}`, { ...json({ note: "changed" }), method: "PATCH" }, env)).json() as { note: string };
    expect(edited.note).toBe("changed");

    const forDoc = await (await root.request(`/v1/highlights?document_id=${link.id}`, {}, env)).json() as { highlights: unknown[] };
    expect(forDoc.highlights).toHaveLength(1);

    await root.request(`/v1/highlights/${h.id}`, { method: "DELETE" }, env);
    const after = await (await root.request("/v1/highlights", {}, env)).json() as { highlights: unknown[] };
    expect(after.highlights).toHaveLength(0);

    const missing = await root.request("/v1/highlights", json({ document_id: "nope", text: "x" }), env);
    expect(missing.status).toBe(404);
  });

  it("stars, tags and retitles a link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAGE, { headers: { "content-type": "text/html" } })));
    const env = { DB: d1() } as Env;
    const root = app();
    const link = await (await root.request("/v1/links", json({ url: "https://example.com/post" }), env)).json() as { id: string };
    const patch = (body: unknown) => root.request(`/v1/links/${link.id}`, { ...json(body), method: "PATCH" }, env);

    const starred = await (await patch({ starred: true, tags: ["AI", "agents", "ai"], title: "Schemas" })).json() as { starred_at: string; tags: string[]; title: string; image_url: string };
    expect(starred.starred_at).toBeTruthy();
    expect(starred.tags).toEqual(["ai", "agents"]);
    expect(starred.title).toBe("Schemas");
    expect(starred.image_url).toBe("https://example.com/img/lead.jpg");   // frontmatter kept

    const list = await (await root.request("/v1/links?state=starred", {}, env)).json() as { links: unknown[] };
    expect(list.links).toHaveLength(1);

    const unstarred = await (await patch({ starred: false })).json() as { starred_at: string | null; tags: string[] };
    expect(unstarred).toMatchObject({ starred_at: null, tags: ["ai", "agents"] });
    expect((await patch({ tags: "nope" })).status).toBe(400);
  });
});

describe("visits", () => {
  it("stores visits once, however often they're sent, and keeps Today's place current", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const now = new Date().toISOString();
    const batch = {
      visits: [
        { latitude: 38.9, longitude: -77.03, arrived_at: "2024-05-01T13:00:00Z", departed_at: "2024-05-01T15:00:00Z", place: "Blue Bottle", source: "google-timeline", source_key: "gt:2024-05-01T13:00:00Z:abc" },
        { latitude: 38.91, longitude: -77.04, arrived_at: "2024-05-01T18:00:00Z", source: "photos" },
        { latitude: 999, longitude: 0, arrived_at: "2024-05-01T18:00:00Z", source: "photos" },
        { latitude: 38.92, longitude: -77.05, arrived_at: now, place: "Home", city: "Washington", source: "visit" },
      ],
    };
    const first = await (await root.request("/v1/visits", json(batch), env)).json() as { received: number; valid: number; added: number };
    expect(first).toEqual({ received: 4, valid: 3, added: 3 });
    const again = await (await root.request("/v1/visits", json(batch), env)).json() as { added: number };
    expect(again.added).toBe(0);

    const list = await (await root.request("/v1/visits", {}, env)).json() as { visits: Array<{ place: string | null }>; sources: unknown[] };
    expect(list.visits.map((v) => v.place)).toEqual(["Home", null, "Blue Bottle"]);
    expect(list.sources).toHaveLength(3);

    const latest = await env.DB.prepare("SELECT label, source FROM location_history").all<{ label: string; source: string }>();
    expect(latest.results).toEqual([{ label: "Home", source: "visit" }]);
    expect((await root.request("/v1/visits", json({ visits: [] }), env)).status).toBe(400);
  });
});

describe("places map", () => {
  const seed = async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const v = (lat: number, lng: number, at: string, mins: number, place?: string) => ({
      latitude: lat, longitude: lng, arrived_at: at, departed_at: new Date(Date.parse(at) + mins * 60_000).toISOString(),
      place, source: "google-timeline",
    });
    const visits = [
      v(38.8977, -77.0365, "2024-05-01T12:00:00Z", 60, "Home"),
      v(38.8978, -77.0366, "2024-05-02T12:00:00Z", 120, "Home"),
      v(38.9100, -77.0400, "2024-05-01T15:00:00Z", 30),
      v(37.7749, -122.4194, "2024-06-10T18:00:00Z", 90),
      v(37.7800, -122.4100, "2024-06-11T18:00:00Z", 45),
      v(38.8977, -77.0365, "2023-11-23T15:00:00Z", 10, "Home"),
    ];
    const res = await root.request("/v1/visits", json({ visits }), env);
    expect((await res.json() as { added: number }).added).toBe(6);
    return { env, root };
  };

  it("groups visits into places with time spent and names", async () => {
    const { env, root } = await seed();
    let body = await (await root.request("/v1/visits/places", {}, env)).json() as { places: Array<Record<string, unknown>> };
    expect(body.places[0]).toMatchObject({ key: "38.898,-77.037", visits: 3, minutes: 190, name: "Home", label: "Home" });
    await root.request("/v1/visits/names", json({ names: [{ key: "38.910,-77.040", name: "Blue Bottle", city: "Washington" }, { key: "bad" }] }), env);
    body = await (await root.request("/v1/visits/places?year=2024", {}, env)).json() as typeof body;
    expect(body.places.find((p) => p.key === "38.910,-77.040")).toMatchObject({ name: "Blue Bottle", city: "Washington" });
    expect(body.places.find((p) => p.key === "38.898,-77.037")).toMatchObject({ visits: 2 });
    const years = await (await root.request("/v1/visits/years", {}, env)).json() as { years: unknown[] };
    expect(years.years).toEqual([{ year: "2023", visits: 1, places: 1 }, { year: "2024", visits: 5, places: 4 }]);
    const at = await (await root.request("/v1/visits/at?key=38.898,-77.037", {}, env)).json() as { visits: unknown[] };
    expect(at.visits).toHaveLength(3);
  });

  it("finds a day, past years on this date, and trips away from home", async () => {
    const { env, root } = await seed();
    await root.request("/v1/visits/journeys", json({ journeys: [
      { started_at: "2024-05-01T13:00:00Z", ended_at: "2024-05-01T13:20:00Z", start_lat: 38.8977, start_lng: -77.0365,
        end_lat: 38.91, end_lng: -77.04, distance_m: 1500, mode: "WALKING", source: "google-timeline", source_key: "j1" },
      { started_at: "2024-05-01T13:00:00Z", source: "google-timeline", source_key: "j1" },
      { started_at: "2024-05-01T14:00:00Z", mode: "path", points: [[38.9, -77.0, 0], [38.91, -77.04, 5]], source: "google-timeline", source_key: "p1" },
    ] }), env);
    const day = await (await root.request("/v1/visits/day?date=2024-05-01&offset=-240", {}, env)).json() as { visits: Array<{ key: string }>; journeys: Array<{ mode: string; points_json: string | null }> };
    expect(day.visits.map((v) => v.key)).toEqual(["38.898,-77.037", "38.910,-77.040"]);
    expect(day.journeys.map((j) => j.mode)).toEqual(["walking", "path"]);
    expect(JSON.parse(day.journeys[1].points_json!)).toEqual([[38.9, -77, 0], [38.91, -77.04, 5]]);
    const otd = await (await root.request("/v1/visits/on-this-day?md=11-23&offset=-300", {}, env)).json() as { visits: unknown[] };
    expect(otd.visits).toHaveLength(1);
    const days = await (await root.request("/v1/visits/days?year=2024&offset=-240", {}, env)).json() as { days: Array<{ day: string }> };
    expect(days.days.map((d) => d.day)).toEqual(["2024-05-01", "2024-05-02", "2024-06-10", "2024-06-11"]);
    const trips = await (await root.request("/v1/visits/trips?offset=-240", {}, env)).json() as { trips: Array<Record<string, unknown>> };
    expect(trips.trips).toHaveLength(1);
    expect(trips.trips[0]).toMatchObject({ start: "2024-06-10", end: "2024-06-11", days: 2, places: 2 });
  });

  it("joins away days into trips, split by a gap of more than two days", () => {
    const d = (day: string, keys: string) => ({ day, visits: 2, lat: 1, lng: 1, min_lat: 0, max_lat: 2, min_lng: 0, max_lng: 2,
      keys, cities: "Paris|Paris|Lyon", countries: "France" });
    const trips = findTrips([d("2024-01-01", "a|b"), d("2024-01-03", "b|c"), d("2024-02-01", "x")]);
    expect(trips.map((t) => [t.start, t.days, t.places, t.city])).toEqual([["2024-02-01", 1, 1, "Paris"], ["2024-01-01", 3, 3, "Paris"]]);
  });
});

describe("music history", () => {
  const recent = {
    items: [
      { played_at: "2026-11-23T10:00:00Z", track: { id: "t1", name: "Song A", duration_ms: 180000, artists: [{ name: "Artist" }],
        album: { name: "LP", images: [{ url: "https://i/1.jpg" }] }, external_urls: { spotify: "https://open.spotify.com/track/t1" } } },
      { played_at: "2026-11-23T09:00:00Z", track: { id: "t1", name: "Song A", duration_ms: 180000, artists: [{ name: "Artist" }] } },
      { played_at: "2026-11-23T08:00:00Z", track: { id: "e1" } },
    ],
  };

  it("keeps each play once and reports history and favourites", async () => {
    const env = { DB: d1() } as Env;
    const plays = playsFrom(recent);
    expect(plays).toHaveLength(2);
    expect(plays[0]).toMatchObject({ track: "Song A", artists: "Artist", album: "LP", image_url: "https://i/1.jpg" });
    expect(await savePlays(env.DB, plays)).toBe(2);
    expect(await savePlays(env.DB, plays)).toBe(0);
    const root = new Hono<{ Bindings: Env }>();
    root.route("/v1/music", createMusicRoute());
    const history = await (await root.request("/v1/music/history?limit=1", {}, env)).json() as { plays: unknown[]; total: { n: number } };
    expect(history.plays).toHaveLength(1);
    expect(history.total.n).toBe(2);
    vi.setSystemTime(new Date("2026-11-24T00:00:00Z"));
    const top = await (await root.request("/v1/music/top?days=7", {}, env)).json() as { plays: number; minutes: number; tracks: Array<{ plays: number }> };
    vi.useRealTimers();
    expect(top.plays).toBe(2);
    expect(top.minutes).toBe(6);
    expect(top.tracks[0].plays).toBe(2);
  });
});
