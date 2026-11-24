import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { MAX_PATH, SectionError, createSection, deleteSection, listSections, updateSection } from "../services/sections";

// /v1/sections: Writing's folders, as a tree (Library › Agent Skills).
// A folder is named by its path, the string pages already keep in
// documents.folder. Moving a page into a folder is PUT /v1/documents/:id
// { folder }. Private: nothing here reaches anuragd.me.

const app = new Hono<{ Bindings: Env }>();

const Name = z.string().trim().min(1).max(80)
  .refine((s) => !s.includes("/"), "can't contain /")
  .refine((s) => s !== "." && s !== "..", "isn't a folder name");
const Path = z.string().trim().max(MAX_PATH);

export const CreateSection = z.object({
  name: Name,
  parent: Path.optional(),
  sort_order: z.number().int().min(0).max(1_000_000).nullish(),
}).strict();

export const UpdateSection = z.object({
  path: Path.min(1),
  name: Name.optional(),
  parent: Path.optional(),
  sort_order: z.number().int().min(0).max(1_000_000).nullish(),
}).strict();

export const DeleteSection = z.object({ path: Path.min(1) }).strict();

const SectionSchema = z.object({
  path: z.string(),
  name: z.string(),
  parent: z.string(),
  depth: z.number().int(),
  count: z.number().int(),
  total: z.number().int(),
  sort_order: z.number().int().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export const SectionList = z.object({
  items: z.array(SectionSchema),
  unsorted: z.number().int(),
  server_time: z.string(),
});
export const SectionChange = z.object({ section: SectionSchema, moved_pages: z.number().int(), moved_folders: z.number().int() });
export const SectionDeleted = z.object({ ok: z.literal(true), parent: z.string(), moved_pages: z.number().int(), moved_folders: z.number().int() });

/** One error shape for new routes: { error: { code, message } }. */
function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof z.ZodError) {
    return c.json({ error: { code: "invalid", message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
  }
  if (error instanceof SectionError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
  console.error("sections route failed", error);
  return c.json({ error: { code: "server", message: "Folder request failed" } }, 500);
}

async function body(c: Context<{ Bindings: Env }>) {
  const json = await parseJson(c.req.raw);
  if (json === null || typeof json !== "object") throw new SectionError("Send a JSON object", 400, "invalid");
  return json;
}

/** GET /v1/sections → { items (depth first), unsorted, server_time } */
app.get("/", async (c) => {
  try {
    const { items, unsorted } = await listSections(c.env);
    return c.json(SectionList.parse({ items, unsorted, server_time: new Date().toISOString() }));
  } catch (error) {
    return fail(c, error);
  }
});

/** POST /v1/sections { name, parent? } → 201 { section } */
app.post("/", async (c) => {
  try {
    const input = CreateSection.parse(await body(c));
    const section = await createSection(c.env, input);
    return c.json({ section: SectionSchema.parse(section) }, 201);
  } catch (error) {
    return fail(c, error);
  }
});

/** PATCH /v1/sections { path, name?, parent?, sort_order? }: rename, nest or reorder. */
app.patch("/", async (c) => {
  try {
    const input = UpdateSection.parse(await body(c));
    return c.json(SectionChange.parse(await updateSection(c.env, input)));
  } catch (error) {
    return fail(c, error);
  }
});

/**
 * DELETE /v1/sections { path } (or ?path=): removes the folder, never its
 * pages. Its notes and folders move up into its parent.
 */
app.delete("/", async (c) => {
  try {
    const query = c.req.query("path");
    const input = DeleteSection.parse(query !== undefined ? { path: query } : await body(c));
    return c.json(SectionDeleted.parse(await deleteSection(c.env, input.path)));
  } catch (error) {
    return fail(c, error);
  }
});

export default app;
