import { Hono } from "hono";
import type { Env } from "../types/env";
import { parseJsonAs } from "../utils/json";
import { cursorFrom, fail as failWithMessage, appErrors, later, limitFrom, list, objectBody, page } from "../lib/http";
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
import { NOTE_PHOTO_PREFIX, notePhotoRef, notePhotoUrl } from "../services/note-photos";
import { photoResponse, receivePhoto } from "../lib/private-photos";
import { z } from "zod";
import {
  authSecurity,
  cursorQuery,
  imageUploadSchema,
  pageFields,
  structuredErrorResponses,
  structuredCreatedResponses,
  structuredErrorSchema,
  structuredOkResponses,
  okSchema,
  openApiJsonRequestBody,
  apiTags,
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
const TAG = "Inbox";
apiTags.push({
  name: TAG,
  description: `Notes and writing (documents), and the Inbox where anything shared or captured lands first. \
Notes are sorted into folders: GET /v1/sections lists them as a tree, and POST, PATCH and DELETE /v1/sections \
create, rename or move, and remove one (its notes move up, never deleted). Only notes live in folders. \
Links have their own routes (Reading), and so do journal entries (Journal).

**Capturing.** For something to keep (a thought, a screenshot, a shared image, a snippet), POST /v1/capture. \
It makes a new note in the Inbox folder: the first line of \`text\` is the title, the rest the body. \
A \`text\` that is only a URL is saved to Read later instead (no note). \
Screenshots and shared images belong here as notes, never in Photography (/v1/photos holds only real photographs for the site).

**Photos.** Upload each image first: POST /v1/documents/photos with the raw bytes as the body and its Content-Type \
(image/jpeg, image/png, image/heic or image/webp; up to 15 MB). It is stored in the private bucket (R2_PRIVATE) and you get back \
\`ref\` and \`url\`. Then either pass the refs as \`photos\` to POST /v1/capture (the photos follow any words), or put \
\`![](url)\` in a note's \`body\`. A note's photos are private: \`url\` is this API's authenticated route, not a public link. \
Don't use /v1/blog-images or /v1/photos for a note's images.

**Order.** To find something first, GET /v1/search?q= (titles and bodies) or GET /v1/documents?folder=. \
POST /v1/documents creates a note (\`kind\` note by default; folder "" is unsorted). \
PUT /v1/documents/{id} saves: send the \`version\` you loaded; a 409 means it changed and carries \`latest\`. \
Fields left out of a PUT keep their value. Every save keeps the previous version (GET …/versions). \
DELETE is soft. Move a note to a folder by saving it with a new \`folder\`.

**Visibility.** \`visibility\` is who a document is for: private (only the owner, the default), agents (the owner and their agents), \
locked (journal entries; never shown to agents), public (published writing). The API doesn't enforce it, so respect it: \
don't read out or quote private or locked documents unless the owner asks. Leave \`visibility\` out when you write.

**What is public.** Notes are private: nothing in a note is shown on anuragd.me. Only writing (\`kind\` writing) can go on the site, \
as a post: POST /v1/documents/{id}/publish copies it (and public copies of its photos) to /v1/posts. Writing is always created \
as a draft. Agents never publish: only the owner publishes, after a two-step confirm. Saving a piece that is already published \
updates the live post at once, so don't edit published writing unless asked. Deleting a published piece leaves its post up: \
unpublish first.`,
});
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
  tags: [TAG],
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
  tags: [TAG],
  summary: "Get document",
  security: authSecurity,
  request: { params: idParams },
  responses: { ...structuredOkResponses(documentSchema), ...notFound },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/documents/{id}/versions",
  tags: [TAG],
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
  tags: [TAG],
  summary: "Create document",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(documentInputSchema.omit({ version: true })) },
  responses: structuredCreatedResponses(documentSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/documents/{id}",
  tags: [TAG],
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
  tags: [TAG],
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
    tags: [TAG],
    summary,
    security: authSecurity,
    request: { params: idParams },
    responses: { ...structuredOkResponses(documentSchema), ...notFound },
  });
}

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/search",
  tags: [TAG],
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
  path: "/v1/documents/photos",
  tags: [TAG],
  summary: "Upload a private photo for a note (up to 15 MB)",
  description: "Kept in the private bucket. Put ![](url) in the note; publishing a piece of writing copies its photos to the public bucket for the site.",
  security: authSecurity,
  request: {
    body: {
      description: "JPEG, PNG, HEIC or WebP image",
      content: { "image/*": { schema: imageUploadSchema } },
    },
  },
  responses: {
    201: openApiResponse(z.object({ ref: z.string(), url: z.string(), content_type: z.string(), size: z.number().int() }), "Created"),
    ...structuredErrorResponses,
    413: openApiResponse(structuredErrorSchema, "Photo too large"),
    415: openApiResponse(structuredErrorSchema, "Unsupported image type"),
    503: openApiResponse(structuredErrorSchema, "No private bucket"),
  },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/documents/photos/{name}",
  tags: [TAG],
  summary: "Get a note photo",
  security: authSecurity,
  request: { params: z.object({ name: z.string().openapi({ description: "The ref without its notes/ prefix" }) }) },
  responses: {
    200: { description: "The image", content: { "image/*": { schema: imageUploadSchema } } },
    ...structuredErrorResponses,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/capture",
  tags: [TAG],
  summary: "Capture text or photos to the Inbox (a bare URL is saved to Read later)",
  description: "Send text, photos or both. photos are refs from POST /v1/documents/photos; with photos it is always a note.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(z.object({
    text: z.string().max(20000).optional().openapi({
      description: "The words. The first line becomes the note's title. Only a URL: saved to Read later instead. Needed unless photos are sent",
    }),
    photos: z.array(z.string()).max(20).optional().openapi({
      description: "Refs from POST /v1/documents/photos (notes/…), up to 20. With photos it is always a note",
    }),
  })) },
  responses: structuredCreatedResponses(z.object({
    ok: z.boolean(),
    document: documentSummarySchema.optional().openapi({ description: "The new Inbox note" }),
    link: linkSchema.optional().openapi({ description: "The saved link, when text was a single URL" }),
  })),
});

// App-only: errors are { error: { code, message } } (lib/http.ts).
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

// MARK: Photos in notes (private R2 objects, served only through this authenticated route)

/** POST /v1/documents/photos (raw image body) → { ref, url }: put `![](url)` in a note. */
app.post("/photos", async (c) => {
  // Never the public bucket: a note's photo has no public address until its piece is published.
  if (!c.env.R2_PRIVATE) return failWithMessage(c, 503, "Private photo storage isn't set up");
  const stored = await receivePhoto(c, NOTE_PHOTO_PREFIX, c.env.R2_PRIVATE);
  if (stored instanceof Response) return stored;
  return c.json({ ref: stored.ref, url: notePhotoUrl(apiBase(c), stored.ref), content_type: stored.content_type, size: stored.size }, 201);
});

/** GET /v1/documents/photos/:name: the image, for the signed-in apps only. */
app.get("/photos/:name", async (c) => {
  const ref = notePhotoRef(c.req.param("name"));
  const object = ref ? await c.env.R2_PRIVATE?.get(ref) : null;
  if (!object) return failWithMessage(c, 404, "No such photo");
  return photoResponse(object);
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

// A body that isn't an object (true, [1], "text") is a 400; it used to make an Untitled note.
app.post("/", async (c) => {
  const body = (await objectBody(c)) as DocumentInput;
  return c.json(present(await createDocument(c.env, body)), 201);
});

app.put("/:id", async (c) => {
  const body = (await objectBody(c)) as DocumentInput;
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

const CaptureBody = z.object({
  text: z.string().transform((t) => t.trim()).pipe(z.string().max(20000)).optional(),
  photos: z.array(z.string()).max(20).optional(),
});

/** This API's own address, for links to its authenticated routes. */
function apiBase(c: { env: Env; req: { url: string } }): string {
  return c.env.API_BASE_URL || new URL(c.req.url).origin;
}

/**
 * POST /v1/capture { text?, photos? } → a new note in Inbox (a bare URL goes to
 * Read later). `photos` are refs from POST /v1/documents/photos; with them it is
 * always a note, the photos after any words.
 */
export const captureRoute = appErrors(new Hono<{ Bindings: Env }>(), "Documents request");
captureRoute.post("/", async (c) => {
  const parsed = await parseJsonAs(c.req.raw, CaptureBody);
  if (!parsed.success) return failWithMessage(c, 400, "text is required (up to 20000 characters)");
  const text = parsed.data.text ?? "";
  const refs = (parsed.data.photos ?? []).map(notePhotoRef);
  if (!text && refs.length === 0) return failWithMessage(c, 400, "text is required (up to 20000 characters)");
  if (refs.some((ref) => ref === null)) return failWithMessage(c, 400, "photos must be refs from POST /v1/documents/photos");
  if (refs.length > 0) {
    if (!c.env.R2_PRIVATE) return failWithMessage(c, 503, "Private photo storage isn't set up");
    for (const ref of refs) {
      if (!(await c.env.R2_PRIVATE.head(ref!))) return failWithMessage(c, 400, `No such photo: ${ref}`);
    }
    const urls = refs.map((ref) => notePhotoUrl(apiBase(c), ref!));
    const note = await captureToInbox(c.env, text, new Date(), { photos: urls, textIsLink: isSingleUrl(text) });
    return c.json({ ok: true, document: present(note, false) }, 201);
  }
  // A bare URL is something to read later, not a line in the inbox.
  // Either way something new is made (as POST /v1/links and POST /v1/documents answer): 201.
  if (isSingleUrl(text)) return c.json({ ok: true, link: presentLink(await saveLink(c.env, text, new Date(), later(c))) }, 201);
  const note = await captureToInbox(c.env, text);
  return c.json({ ok: true, document: present(note, false) }, 201);
});

export default app;
