import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import {
  DocumentError,
  captureToDump,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  present,
  saveDocument,
  searchDocuments,
  setPublished,
  type DocumentInput,
} from "../services/documents";

// /v1/documents: everything the OS writes and keeps (Cloudflare is the source of truth).
const app = new Hono<{ Bindings: Env }>();

function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof DocumentError) return c.json({ error: error.message }, error.status);
  console.error("documents route failed", error);
  return c.json({ error: "Documents request failed" }, 500);
}

app.get("/", async (c) => {
  try {
    const rows = await listDocuments(c.env, {
      kind: c.req.query("kind"),
      folder: c.req.query("folder"),
      updatedSince: c.req.query("updated_since"),
      includeBody: c.req.query("include") === "body",
      includeDeleted: c.req.query("include_deleted") === "1",
      limit: Number(c.req.query("limit")) || undefined,
    });
    const includeBody = c.req.query("include") === "body";
    return c.json({
      documents: rows.map((row) => ({ ...present(row, includeBody), ...(row.deleted_at ? { deleted_at: row.deleted_at } : {}) })),
      server_time: new Date().toISOString(),
    });
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/:id", async (c) => {
  try {
    return c.json(present(await getDocument(c.env, c.req.param("id"))));
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/:id/versions", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT version, title, saved_at, length(body) AS length FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 100",
  ).bind(c.req.param("id")).all();
  return c.json({ versions: results });
});

app.post("/", async (c) => {
  const body = (await parseJson(c.req.raw)) as DocumentInput | null;
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  try {
    return c.json(present(await createDocument(c.env, body)), 201);
  } catch (error) {
    return fail(c, error);
  }
});

app.put("/:id", async (c) => {
  const body = (await parseJson(c.req.raw)) as DocumentInput | null;
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  try {
    return c.json(present(await saveDocument(c.env, c.req.param("id"), body)));
  } catch (error) {
    if (error instanceof DocumentError && error.status === 409) {
      const latest = await getDocument(c.env, c.req.param("id")).catch(() => null);
      return c.json({ error: error.message, latest: latest ? present(latest) : null }, 409);
    }
    return fail(c, error);
  }
});

app.delete("/:id", async (c) => {
  try {
    await deleteDocument(c.env, c.req.param("id"));
    return c.json({ ok: true });
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/:id/publish", async (c) => {
  try {
    return c.json(present(await setPublished(c.env, c.req.param("id"), true)));
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/:id/unpublish", async (c) => {
  try {
    return c.json(present(await setPublished(c.env, c.req.param("id"), false)));
  } catch (error) {
    return fail(c, error);
  }
});

/** GET /v1/search?q= across titles and bodies (FTS5). */
export const searchRoute = new Hono<{ Bindings: Env }>();
searchRoute.get("/", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (!q) return c.json({ results: [] });
  try {
    return c.json({ results: await searchDocuments(c.env, q, Number(c.req.query("limit")) || 30) });
  } catch (error) {
    return fail(c, error);
  }
});

/** POST /v1/capture { text } → Dump inbox. */
export const captureRoute = new Hono<{ Bindings: Env }>();
captureRoute.post("/", async (c) => {
  const body = (await parseJson(c.req.raw)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 4000) return c.json({ error: "text is required (up to 4000 characters)" }, 400);
  try {
    const dump = await captureToDump(c.env, text);
    return c.json({ ok: true, document: present(dump, false) });
  } catch (error) {
    return fail(c, error);
  }
});

export default app;
