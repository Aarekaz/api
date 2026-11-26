import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { appErrors } from "../lib/http";
import { parseJson } from "../utils/json";
import {
  authSecurity,
  openApiJsonRequestBody,
  openApiRegistry,
  openApiResponse,
  structuredCreatedResponses,
  structuredErrorSchema,
  structuredOkResponses,
} from "../schemas/openapi";
import { MAX_PATH, SectionError, createSection, deleteSection, listSections, updateSection } from "../services/sections";

// /v1/sections: Writing's folders, as a tree (Library › Agent Skills).
// A folder is named by its path, the string pages already keep in
// documents.folder. Moving a page into a folder is PUT /v1/documents/:id
// { folder }. Private: nothing here reaches anuragd.me.

const app = appErrors(new Hono<{ Bindings: Env }>(), "Folder request");

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

// OpenAPI registrations
const sectionConflict = { 409: openApiResponse(structuredErrorSchema, "A folder with that path already exists") };

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/sections",
  summary: "List Writing folders as a tree (depth first)",
  security: authSecurity,
  responses: structuredOkResponses(SectionList),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/sections",
  summary: "Create folder",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(CreateSection) },
  responses: { ...structuredCreatedResponses(z.object({ section: SectionSchema })), ...sectionConflict },
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/sections",
  summary: "Rename, nest or reorder a folder",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(UpdateSection) },
  responses: { ...structuredOkResponses(SectionChange), ...sectionConflict },
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/sections",
  summary: "Delete a folder (its pages and folders move up into its parent)",
  description: "The path can be sent as ?path= or in a JSON body { path }.",
  security: authSecurity,
  request: {
    query: z.object({ path: z.string().optional() }),
    body: { ...openApiJsonRequestBody(DeleteSection), required: false },
  },
  responses: structuredOkResponses(SectionDeleted),
});

/** One error shape, { error: { code, message } } (lib/http.ts). */

async function body(c: Context<{ Bindings: Env }>) {
  const json = await parseJson(c.req.raw);
  if (json === null || typeof json !== "object") throw new SectionError("Send a JSON object", 400, "invalid");
  return json;
}

/** GET /v1/sections → { items (depth first), unsorted, server_time } */
app.get("/", async (c) => {
  const { items, unsorted } = await listSections(c.env);
  return c.json(SectionList.parse({ items, unsorted, server_time: new Date().toISOString() }));
});

/** POST /v1/sections { name, parent? } → 201 { section } */
app.post("/", async (c) => {
  const input = CreateSection.parse(await body(c));
  const section = await createSection(c.env, input);
  return c.json({ section: SectionSchema.parse(section) }, 201);
});

/** PATCH /v1/sections { path, name?, parent?, sort_order? }: rename, nest or reorder. */
app.patch("/", async (c) => {
  const input = UpdateSection.parse(await body(c));
  return c.json(SectionChange.parse(await updateSection(c.env, input)));
});

/**
 * DELETE /v1/sections { path } (or ?path=): removes the folder, never its
 * pages. Its notes and folders move up into its parent.
 */
app.delete("/", async (c) => {
  const query = c.req.query("path");
  const input = DeleteSection.parse(query !== undefined ? { path: query } : await body(c));
  return c.json(SectionDeleted.parse(await deleteSection(c.env, input.path)));
});

export default app;
