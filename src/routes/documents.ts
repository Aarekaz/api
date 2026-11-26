import { Hono } from "hono";
import type { Env } from "../types/env";
import { parseJson, parseJsonAs } from "../utils/json";
import { cursorFrom, fail as failWithMessage, appErrors, later, limitFrom, list, page } from "../lib/http";
import {
  DocumentError,
  captureToInbox,
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
import { isSingleUrl, presentLink, saveLink } from "../services/links";
import { z } from "zod";
import {
  authSecurity,
  cursorQuery,
  pageFields,
  structuredCreatedResponses,
  structuredErrorSchema,
  structuredOkResponses,
  okSchema,
  openApiJsonRequestBody,
  openApiRegistry,
  openApiResponse,
} from "../schemas/openapi";
import {
  documentInputSchema,
  documentKindSchema,
  documentSchema,
  documentStatusSchema,
  documentSummarySchema,
  documentVisibilitySchema,
  linkSchema,
} from "../schemas/documents";

// /v1/documents: everything the OS writes and keeps (Cloudflare is the source of truth).
const app = appErrors(new Hono<{ Bindings: Env }>(), "Documents request");

// OpenAPI registrations
const listedDocument = documentSummarySchema.extend({
  body: z.string().optional(),
  frontmatter: z.record(z.unknown()).optional(),
  deleted_at: z.string().optional(),
});
const idParams = z.object({ id: z.string().openapi({ description: "Document ULID" }) });
const notFound = { 404: openApiResponse(structuredErrorSchema, "Document not found") };

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/documents",
  summary: "List documents, most recently updated first",
  description: "Without include=body the items leave out body and frontmatter. "
    + "With include_deleted=1, deleted documents are included with their deleted_at.",
  security: authSecurity,
  request: {
    query: z.object({
      kind: documentKindSchema.optional(),
      folder: z.string().optional(),
      updated_since: z.string().optional().openapi({ description: "Only documents updated after this ISO time" }),
      include: z.enum(["body"]).optional(),
      include_deleted: z.enum(["1"]).optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional().openapi({ description: "Default 2000" }),
      cursor: cursorQuery,
    }),
  },
  responses: structuredOkResponses(z.object({
    server_time: z.string(),
    ...pageFields(listedDocument),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/documents/{id}",
  summary: "Get document",
  security: authSecurity,
  request: { params: idParams },
  responses: { ...structuredOkResponses(documentSchema), ...notFound },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/documents/{id}/versions",
  summary: "List a document's saved versions (latest 100)",
  security: authSecurity,
  request: { params: idParams },
  responses: structuredOkResponses(z.object({
    versions: z.array(z.object({
      version: z.number().int(),
      title: z.string(),
      saved_at: z.string(),
      length: z.number().int().openapi({ description: "Body length in characters" }),
    })),
  })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/documents",
  summary: "Create document",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(documentInputSchema.omit({ version: true })) },
  responses: structuredCreatedResponses(documentSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/documents/{id}",
  summary: "Save document",
  description: "Optimistic concurrency: send the version you loaded. A stale version is a 409 with the latest document.",
  security: authSecurity,
  request: {
    params: idParams,
    body: openApiJsonRequestBody(documentInputSchema.extend({ version: z.number().int() })),
  },
  responses: {
    ...structuredOkResponses(documentSchema),
    ...notFound,
    409: openApiResponse(
      structuredErrorSchema.extend({ latest: documentSchema.nullable() }),
      "The document changed since you loaded it",
    ),
  },
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/documents/{id}",
  summary: "Delete document (soft)",
  security: authSecurity,
  request: { params: idParams },
  responses: { ...structuredOkResponses(okSchema), ...notFound },
});

for (const [action, summary] of [
  ["publish", "Publish document to the website"],
  ["unpublish", "Unpublish document"],
] as const) {
  openApiRegistry.registerPath({
    method: "post",
    path: `/v1/documents/{id}/${action}`,
    summary,
    security: authSecurity,
    request: { params: idParams },
    responses: { ...structuredOkResponses(documentSchema), ...notFound },
  });
}

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/search",
  summary: "Full-text search across document titles and bodies",
  security: authSecurity,
  request: {
    query: z.object({
      q: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: "Default 30" }),
    }),
  },
  responses: structuredOkResponses(z.object({
    results: z.array(z.object({
      id: z.string(),
      kind: documentKindSchema,
      folder: z.string(),
      title: z.string(),
      slug: z.string(),
      visibility: documentVisibilitySchema,
      status: documentStatusSchema.nullable(),
      updated_at: z.string(),
      snippet: z.string().openapi({ description: "Matching text with hits in [brackets]" }),
    })),
  })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/capture",
  summary: "Capture text to the Inbox (a bare URL is saved to Read later)",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(z.object({ text: z.string().min(1).max(20000) })) },
  responses: structuredOkResponses(z.object({
    ok: z.boolean(),
    document: documentSummarySchema.optional().openapi({ description: "The new Inbox note" }),
    link: linkSchema.optional().openapi({ description: "The saved link, when text was a single URL" }),
  })),
});

// App-only: errors are { error: { code, message } } (lib/http.ts).
const invalidJson = (c: Parameters<typeof failWithMessage>[0]) => failWithMessage(c, 400, "Invalid JSON");

app.get("/", async (c) => {
  const limit = limitFrom(c, 2000, 5000);
  const rows = await listDocuments(c.env, {
    kind: c.req.query("kind"),
    folder: c.req.query("folder"),
    updatedSince: c.req.query("updated_since"),
    includeBody: c.req.query("include") === "body",
    includeDeleted: c.req.query("include_deleted") === "1",
    limit,
    after: cursorFrom(c, 2) as [string, string] | null,
  });
  const includeBody = c.req.query("include") === "body";
  const { items, next_cursor } = page(rows, limit, (row) => [row.updated_at, row.id]);
  return list(c, items.map((row) => ({ ...present(row, includeBody), ...(row.deleted_at ? { deleted_at: row.deleted_at } : {}) })),
    next_cursor, { server_time: new Date().toISOString() });
});

app.get("/:id", async (c) => {
  return c.json(present(await getDocument(c.env, c.req.param("id"))));
});

app.get("/:id/versions", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT version, title, saved_at, length(body) AS length FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 100",
  ).bind(c.req.param("id")).all();
  return c.json({ versions: results });
});

app.post("/", async (c) => {
  const body = (await parseJson(c.req.raw)) as DocumentInput | null;
  if (!body) return invalidJson(c);
  return c.json(present(await createDocument(c.env, body)), 201);
});

app.put("/:id", async (c) => {
  const body = (await parseJson(c.req.raw)) as DocumentInput | null;
  if (!body) return invalidJson(c);
  try {
    return c.json(present(await saveDocument(c.env, c.req.param("id"), body)));
  } catch (error) {
    if (error instanceof DocumentError && error.status === 409) {
      const latest = await getDocument(c.env, c.req.param("id")).catch(() => null);
      return failWithMessage(c, 409, error.message, { code: "conflict", extra: { latest: latest ? present(latest) : null } });
    }
    throw error;
  }
});

app.delete("/:id", async (c) => {
  await deleteDocument(c.env, c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/:id/publish", async (c) => {
  return c.json(present(await setPublished(c.env, c.req.param("id"), true)));
});

app.post("/:id/unpublish", async (c) => {
  return c.json(present(await setPublished(c.env, c.req.param("id"), false)));
});

/** GET /v1/search?q= across titles and bodies (FTS5). */
export const searchRoute = appErrors(new Hono<{ Bindings: Env }>(), "Documents request");
searchRoute.get("/", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (!q) return c.json({ results: [] });
  return c.json({ results: await searchDocuments(c.env, q, limitFrom(c, 30, 100)) });
});

const CaptureBody = z.object({ text: z.string().transform((t) => t.trim()).pipe(z.string().min(1).max(20000)) });

/** POST /v1/capture { text } → a new note in Inbox (a bare URL goes to Read later). */
export const captureRoute = appErrors(new Hono<{ Bindings: Env }>(), "Documents request");
captureRoute.post("/", async (c) => {
  const parsed = await parseJsonAs(c.req.raw, CaptureBody);
  if (!parsed.success) return failWithMessage(c, 400, "text is required (up to 20000 characters)");
  const { text } = parsed.data;
  // A bare URL is something to read later, not a line in the inbox.
  if (isSingleUrl(text)) return c.json({ ok: true, link: presentLink(await saveLink(c.env, text, new Date(), later(c))) });
  const note = await captureToInbox(c.env, text);
  return c.json({ ok: true, document: present(note, false) });
});

export default app;
