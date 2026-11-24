import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { createDocument, deleteDocument, DocumentError, getDocument, saveDocument, type DocumentRow } from "../services/documents";

// /v1/journal: your journal as a timeline of moments. Each entry is a locked
// `journal` document (so search, versions, sync and the nightly backup keep
// working), with when it happened, where you were and how you felt kept in
// its frontmatter. Journal entries are never public and never shown to agents.

const app = new Hono<{ Bindings: Env }>();

const Place = z.object({
  name: z.string().trim().min(1).max(200),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
});

const Mood = z.enum(["great", "good", "okay", "low", "rough"]);

const CreateEntry = z.object({
  body: z.string().max(200_000),
  happened_at: z.string().datetime({ offset: true }).optional(),
  place: Place.nullish(),
  mood: Mood.nullish(),
});

const UpdateEntry = z.object({
  version: z.number().int(),
  body: z.string().max(200_000).optional(),
  happened_at: z.string().datetime({ offset: true }).optional(),
  place: Place.nullish(),
  mood: Mood.nullish(),
});

export type JournalEntry = {
  id: string;
  body: string;
  happened_at: string;
  place: z.infer<typeof Place> | null;
  mood: z.infer<typeof Mood> | null;
  created_at: string;
  updated_at: string;
  version: number;
};

type Meta = { happened_at?: string; place?: z.infer<typeof Place> | null; mood?: z.infer<typeof Mood> | null };

function meta(row: { frontmatter_json: string | null }): Meta {
  try { return row.frontmatter_json ? JSON.parse(row.frontmatter_json) as Meta : {}; } catch { return {}; }
}

export function presentEntry(row: DocumentRow): JournalEntry {
  const m = meta(row);
  return {
    id: row.id, body: row.body, happened_at: m.happened_at ?? row.created_at, place: m.place ?? null, mood: m.mood ?? null,
    created_at: row.created_at, updated_at: row.updated_at, version: row.version,
  };
}

/** One error shape for new routes: { error: { code, message } }. */
function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof z.ZodError) {
    return c.json({ error: { code: "invalid", message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
  }
  if (error instanceof DocumentError) {
    const code = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid";
    return c.json({ error: { code, message: error.message } }, error.status);
  }
  console.error("journal route failed", error);
  return c.json({ error: { code: "server", message: "Journal request failed" } }, 500);
}

const iso = (s: string) => new Date(s).toISOString();

/** GET /v1/journal?from=&to=&limit= : entries, newest first, by when they happened. */
app.get("/", async (c) => {
  try {
    const from = c.req.query("from"), to = c.req.query("to");
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 500, 1), 2000);
    const when = "COALESCE(json_extract(frontmatter_json, '$.happened_at'), created_at)";
    const where = ["kind = 'journal'", "deleted_at IS NULL"];
    const args: unknown[] = [];
    if (from && !Number.isNaN(Date.parse(from))) { where.push(`${when} >= ?`); args.push(iso(from)); }
    if (to && !Number.isNaN(Date.parse(to))) { where.push(`${when} < ?`); args.push(iso(to)); }
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM documents WHERE ${where.join(" AND ")} ORDER BY ${when} DESC LIMIT ?`,
    ).bind(...args, limit).all<DocumentRow>();
    return c.json({ items: results.map(presentEntry) });
  } catch (error) {
    return fail(c, error);
  }
});

/** POST /v1/journal { body, happened_at?, place?, mood? } */
app.post("/", async (c) => {
  try {
    const input = CreateEntry.parse(await parseJson(c.req.raw));
    const happened = input.happened_at ? iso(input.happened_at) : new Date().toISOString();
    const row = await createDocument(c.env, {
      kind: "journal", title: happened.slice(0, 16).replace("T", " "), body: input.body, folder: "Journal",
      frontmatter: { happened_at: happened, place: input.place ?? null, mood: input.mood ?? null },
    });
    return c.json(presentEntry(row), 201);
  } catch (error) {
    return fail(c, error);
  }
});

/** PATCH /v1/journal/:id { version, body?, happened_at?, place?, mood? } */
app.patch("/:id", async (c) => {
  try {
    const input = UpdateEntry.parse(await parseJson(c.req.raw));
    const current = await getDocument(c.env, c.req.param("id"));
    if (current.kind !== "journal") throw new DocumentError("Not a journal entry", 404);
    const m = meta(current);
    const next: Meta = {
      happened_at: input.happened_at ? iso(input.happened_at) : m.happened_at ?? current.created_at,
      place: input.place === undefined ? m.place ?? null : input.place,
      mood: input.mood === undefined ? m.mood ?? null : input.mood,
    };
    const row = await saveDocument(c.env, current.id, {
      version: input.version, body: input.body, frontmatter: next,
      title: next.happened_at!.slice(0, 16).replace("T", " "),
    });
    return c.json(presentEntry(row));
  } catch (error) {
    return fail(c, error);
  }
});

/** DELETE /v1/journal/:id (soft: it can come back) */
app.delete("/:id", async (c) => {
  try {
    const current = await getDocument(c.env, c.req.param("id"));
    if (current.kind !== "journal") throw new DocumentError("Not a journal entry", 404);
    await deleteDocument(c.env, current.id);
    return c.json({ ok: true });
  } catch (error) {
    return fail(c, error);
  }
});

export default app;
