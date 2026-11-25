// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
import { testD1 } from "../helpers/d1";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import sectionsRoute from "../../routes/sections";
import documentsRoute from "../../routes/documents";
import { normalizePath, prefixes, rebase } from "../../services/sections";

/** A real SQLite database behind the subset of the D1 API the code uses. */
function d1() {
  const { db, DB } = testD1();
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    summary TEXT, content TEXT, tags_json TEXT, published_at TEXT, pinned INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
  db.exec(readFileSync("migrations/0025_documents.sql", "utf8"));
  db.exec(readFileSync("migrations/0035_sections.sql", "utf8"));
  return { d1: DB, db };
}

type Section = { path: string; name: string; parent: string; depth: number; count: number; total: number };

function setup() {
  const { d1: DB, db } = d1();
  const env = { DB } as Env;
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/sections", sectionsRoute);
  root.route("/v1/documents", documentsRoute);
  const send = (path: string, method = "GET", body?: unknown) =>
    root.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
  const note = async (title: string, folder: string, kind = "note") => {
    const res = await send("/v1/documents", "POST", { kind, title, folder, body: `# ${title}\n\nText.` });
    return (await res.json()) as { id: string; folder: string; version: number };
  };
  const tree = async () => (await (await send("/v1/sections")).json()) as { items: Section[]; unsorted: number; server_time: string };
  const folderOf = (id: string) => (db.prepare("SELECT folder FROM documents WHERE id = ?").get(id) as { folder: string }).folder;
  return { env, db, send, note, tree, folderOf };
}

describe("section paths", () => {
  it("normalizes, expands and rebases paths", () => {
    expect(normalizePath(" Library//Agent Skills/ ")).toBe("Library/Agent Skills");
    expect(prefixes("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
    expect(rebase("a/b/c", "a/b", "x")).toBe("x/c");
    expect(rebase("a/b", "a/b", "")).toBe("");
    expect(rebase("a/b/c", "a", "")).toBe("b/c");
  });
});

describe("/v1/sections", () => {
  it("lists the folders pages already use, as a tree with counts", async () => {
    const { note, tree } = setup();
    await note("One", "Library");
    await note("Two", "Library/Agent Skills");
    await note("Three", "Library/Agent Skills");
    await note("Loose", "");
    await note("Draft", "Writing/Drafts", "writing");
    const { items, unsorted, server_time } = await tree();
    expect(server_time).toMatch(/^\d{4}-/);
    expect(unsorted).toBe(1);
    // Writing's own places are not folders.
    expect(items.map((s) => [s.path, s.depth, s.count, s.total])).toEqual([
      ["Library", 0, 1, 3],
      ["Library/Agent Skills", 1, 2, 2],
    ]);
  });

  it("creates nested folders and keeps them while empty", async () => {
    const { send, tree } = setup();
    let res = await send("/v1/sections", "POST", { name: "Projects" });
    expect(res.status).toBe(201);
    res = await send("/v1/sections", "POST", { name: "Tembo", parent: "Projects" });
    expect(((await res.json()) as { section: Section }).section).toMatchObject({ path: "Projects/Tembo", parent: "Projects", depth: 1, count: 0 });
    expect((await tree()).items.map((s) => s.path)).toEqual(["Projects", "Projects/Tembo"]);
  });

  it("refuses bad names, missing parents and duplicates with one error shape", async () => {
    const { send } = setup();
    await send("/v1/sections", "POST", { name: "Core" });
    const slash = await send("/v1/sections", "POST", { name: "a/b" });
    expect(slash.status).toBe(400);
    expect(await slash.json()).toMatchObject({ error: { code: "invalid" } });
    const orphan = await send("/v1/sections", "POST", { name: "x", parent: "Nowhere" });
    expect(orphan.status).toBe(404);
    expect(await orphan.json()).toMatchObject({ error: { code: "not_found" } });
    const twice = await send("/v1/sections", "POST", { name: "Core" });
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({ error: { code: "exists", message: expect.any(String) } });
    const extra = await send("/v1/sections", "POST", { name: "y", colour: "red" });
    expect(extra.status).toBe(400);
  });

  it("renames a folder and carries its notes and subfolders along", async () => {
    const { send, note, tree, folderOf } = setup();
    const a = await note("A", "Library");
    const b = await note("B", "Library/Agent Skills");
    const res = await send("/v1/sections", "PATCH", { path: "Library", name: "Reading" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ section: { path: "Reading", total: 2 }, moved_pages: 2, moved_folders: 2 });
    expect(folderOf(a.id)).toBe("Reading");
    expect(folderOf(b.id)).toBe("Reading/Agent Skills");
    expect((await tree()).items.map((s) => s.path)).toEqual(["Reading", "Reading/Agent Skills"]);
    // The page's version moved on, so a stale save gets a 409 instead of moving it back.
    const stale = await send(`/v1/documents/${b.id}`, "PUT", { body: "x", folder: "Library/Agent Skills", version: b.version });
    expect(stale.status).toBe(409);
  });

  it("nests a folder inside another, but never inside itself", async () => {
    const { send, note, tree, folderOf } = setup();
    const n = await note("N", "Ideas/Small");
    await send("/v1/sections", "POST", { name: "Projects" });
    const res = await send("/v1/sections", "PATCH", { path: "Ideas", parent: "Projects" });
    expect(res.status).toBe(200);
    expect(folderOf(n.id)).toBe("Projects/Ideas/Small");
    expect((await tree()).items.map((s) => `${"  ".repeat(s.depth)}${s.name}`)).toEqual(["Projects", "  Ideas", "    Small"]);
    const loop = await send("/v1/sections", "PATCH", { path: "Projects", parent: "Projects/Ideas" });
    expect(loop.status).toBe(400);
    const top = await send("/v1/sections", "PATCH", { path: "Projects/Ideas/Small", parent: "" });
    expect(top.status).toBe(200);
    expect(folderOf(n.id)).toBe("Small");
  });

  it("won't rename onto a folder that exists, but allows a change of case", async () => {
    const { send } = setup();
    await send("/v1/sections", "POST", { name: "Core" });
    await send("/v1/sections", "POST", { name: "notes" });
    expect((await send("/v1/sections", "PATCH", { path: "notes", name: "Core" })).status).toBe(409);
    expect((await send("/v1/sections", "PATCH", { path: "notes", name: "Notes" })).status).toBe(200);
    expect((await send("/v1/sections", "PATCH", { path: "Gone", name: "X" })).status).toBe(404);
  });

  it("deletes a folder without deleting a page: pages and subfolders move to the parent", async () => {
    const { send, note, tree, folderOf, db } = setup();
    const direct = await note("Direct", "Library/Agent Skills");
    const deeper = await note("Deeper", "Library/Agent Skills/Claude");
    const sibling = await note("Sibling", "Library");
    const res = await send("/v1/sections", "DELETE", { path: "Library/Agent Skills" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, parent: "Library", moved_pages: 2, moved_folders: 1 });
    expect(folderOf(direct.id)).toBe("Library");
    expect(folderOf(deeper.id)).toBe("Library/Claude");
    expect(folderOf(sibling.id)).toBe("Library");
    const live = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL").get() as { n: number };
    expect(live.n).toBe(3);
    expect((await tree()).items.map((s) => s.path)).toEqual(["Library", "Library/Claude"]);
  });

  it("deleting a top folder sends its pages to Unsorted, by ?path= too", async () => {
    const { send, note, tree, folderOf } = setup();
    const n = await note("N", "Inbox");
    const res = await send(`/v1/sections?path=${encodeURIComponent("Inbox")}`, "DELETE");
    expect(res.status).toBe(200);
    expect(folderOf(n.id)).toBe("");
    expect(await tree()).toMatchObject({ items: [], unsorted: 1 });
    expect((await send("/v1/sections", "DELETE", { path: "Inbox" })).status).toBe(404);
  });

  it("a deleted folder comes back if a page moves into it again", async () => {
    const { send, note, tree } = setup();
    await send("/v1/sections", "POST", { name: "Later" });
    await send("/v1/sections", "DELETE", { path: "Later" });
    expect((await tree()).items).toEqual([]);
    await note("Back", "Later");
    expect((await tree()).items.map((s) => s.path)).toEqual(["Later"]);
  });

  it("never touches writing or the site's posts", async () => {
    const { send, note, db } = setup();
    const draft = await note("Essay", "Library", "writing");
    await send(`/v1/documents/${draft.id}/publish`, "POST");
    const postsBefore = JSON.stringify(db.prepare("SELECT * FROM posts").all());
    const docBefore = JSON.stringify(db.prepare("SELECT * FROM documents WHERE id = ?").get(draft.id));
    await note("A note", "Library");
    await send("/v1/sections", "PATCH", { path: "Library", name: "Shelf" });
    await send("/v1/sections", "DELETE", { path: "Shelf" });
    expect(JSON.stringify(db.prepare("SELECT * FROM posts").all())).toBe(postsBefore);
    expect(JSON.stringify(db.prepare("SELECT * FROM documents WHERE id = ?").get(draft.id))).toBe(docBefore);
  });

  it("leaves the documents list shape as it was (plus items and next_cursor)", async () => {
    const { send, note } = setup();
    await note("Kept", "Library");
    await send("/v1/sections", "PATCH", { path: "Library", name: "Shelf" });
    const list = (await (await send("/v1/documents")).json()) as { documents: Record<string, unknown>[]; server_time: string };
    expect(Object.keys(list).sort()).toEqual(["documents", "items", "next_cursor", "server_time"]);
    expect(Object.keys(list.documents[0]).sort()).toEqual(
      ["created_at", "folder", "id", "kind", "post_id", "slug", "source", "status", "title", "updated_at", "version", "visibility"],
    );
    expect(list.documents[0].folder).toBe("Shelf");
  });
});
