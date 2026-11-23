import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { DocumentError } from "../services/documents";
import { fetchArticle, getLink, listLinks, markRead, presentLink, saveLink, updateLink } from "../services/links";

// /v1/links: read later. Deleting a link is DELETE /v1/documents/:id.
const app = new Hono<{ Bindings: Env }>();

function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof DocumentError) return c.json({ error: error.message }, error.status);
  console.error("links route failed", error);
  return c.json({ error: "Links request failed" }, 500);
}

app.get("/", async (c) => {
  const raw = c.req.query("state");
  const state = raw === "unread" || raw === "read" || raw === "starred" ? raw : "all";
  try {
    const rows = await listLinks(c.env, state, Number(c.req.query("limit")) || undefined);
    return c.json({ links: rows.map((row) => presentLink(row)) });
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/", async (c) => {
  const body = (await parseJson(c.req.raw)) as { url?: unknown } | null;
  if (typeof body?.url !== "string") return c.json({ error: "url is required" }, 400);
  try {
    return c.json(presentLink(await saveLink(c.env, body.url), true), 201);
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/:id", async (c) => {
  try {
    return c.json(presentLink(await getLink(c.env, c.req.param("id")), true));
  } catch (error) {
    return fail(c, error);
  }
});

/** PATCH /v1/links/:id { starred?, tags?, title? } */
app.patch("/:id", async (c) => {
  const body = (await parseJson(c.req.raw)) as { starred?: unknown; tags?: unknown; title?: unknown } | null;
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  try {
    return c.json(presentLink(await updateLink(c.env, c.req.param("id"), body)));
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/:id/read", async (c) => {
  try {
    return c.json(presentLink(await markRead(c.env, c.req.param("id"), true)));
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/:id/unread", async (c) => {
  try {
    return c.json(presentLink(await markRead(c.env, c.req.param("id"), false)));
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/:id/refetch", async (c) => {
  try {
    return c.json(presentLink(await fetchArticle(c.env, c.req.param("id")), true));
  } catch (error) {
    return fail(c, error);
  }
});

export default app;
