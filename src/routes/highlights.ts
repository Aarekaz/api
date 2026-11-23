import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { DocumentError } from "../services/documents";
import { createHighlight, deleteHighlight, listHighlights, presentHighlight, updateHighlight } from "../services/highlights";

// /v1/highlights: passages marked while reading, with notes.
const app = new Hono<{ Bindings: Env }>();

function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof DocumentError) return c.json({ error: error.message }, error.status);
  console.error("highlights route failed", error);
  return c.json({ error: "Highlights request failed" }, 500);
}

app.get("/", async (c) => {
  try {
    const rows = await listHighlights(c.env, c.req.query("document_id") || undefined, Number(c.req.query("limit")) || undefined);
    return c.json({ highlights: rows.map(presentHighlight) });
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/", async (c) => {
  const body = (await parseJson(c.req.raw)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  try {
    return c.json(presentHighlight(await createHighlight(c.env, body)), 201);
  } catch (error) {
    return fail(c, error);
  }
});

app.patch("/:id", async (c) => {
  const body = (await parseJson(c.req.raw)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  try {
    return c.json(presentHighlight(await updateHighlight(c.env, c.req.param("id"), body)));
  } catch (error) {
    return fail(c, error);
  }
});

app.delete("/:id", async (c) => {
  try {
    await deleteHighlight(c.env, c.req.param("id"));
    return c.json({ ok: true });
  } catch (error) {
    return fail(c, error);
  }
});

export default app;
