import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { DocumentError } from "../services/documents";
import { createHighlight, deleteHighlight, listHighlights, presentHighlight, updateHighlight } from "../services/highlights";

// /v1/highlights: passages marked while reading, with notes.
const app = new Hono<{ Bindings: Env }>();

// The apps use yellow, orange, green and blue; any short name is kept, as before.
const Color = z.string().trim().max(20);

const CreateHighlight = z.object({
  document_id: z.string().trim().min(1).max(64),
  text: z.string().max(5_000).refine((t) => t.trim().length > 0, "text is required"),
  prefix: z.string().max(200).nullish(),
  suffix: z.string().max(200).nullish(),
  note: z.string().max(5_000).nullish(),
  color: Color.nullish(),
});

const UpdateHighlight = z.object({
  note: z.string().max(5_000).nullish(),
  color: Color.nullish(),
});

/** One error shape: { error: { code, message } }. */
function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof z.ZodError) {
    return c.json({ error: { code: "invalid", message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
  }
  if (error instanceof DocumentError) {
    const code = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid";
    return c.json({ error: { code, message: error.message } }, error.status);
  }
  console.error("highlights route failed", error);
  return c.json({ error: { code: "server", message: "Highlights request failed" } }, 500);
}

const invalidJson = (c: Context<{ Bindings: Env }>) => c.json({ error: { code: "invalid", message: "Invalid JSON" } }, 400);

app.get("/", async (c) => {
  try {
    const rows = await listHighlights(c.env, c.req.query("document_id") || undefined, Number(c.req.query("limit")) || undefined);
    return c.json({ highlights: rows.map(presentHighlight) });
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return invalidJson(c);
  try {
    return c.json(presentHighlight(await createHighlight(c.env, CreateHighlight.parse(body))), 201);
  } catch (error) {
    return fail(c, error);
  }
});

app.patch("/:id", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return invalidJson(c);
  try {
    // Only the fields that were sent change ("note": null clears the note).
    const input = UpdateHighlight.parse(body);
    const sent = Object.fromEntries(Object.entries(input).filter(([key]) => key in (body as object)));
    return c.json(presentHighlight(await updateHighlight(c.env, c.req.param("id"), sent)));
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
