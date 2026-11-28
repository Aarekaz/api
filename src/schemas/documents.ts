import { z } from "zod";
import "./openapi";

// OpenAPI response shapes for the documents family (/v1/documents, /v1/search,
// /v1/capture, /v1/links). They describe what services/documents.ts present()
// and services/links.ts presentLink() return; nothing at runtime parses them.

export const documentKindSchema = z.enum(["note", "journal", "writing", "link", "quote"]);
export const documentVisibilitySchema = z.enum(["locked", "private", "agents", "public"]);
export const documentStatusSchema = z.enum(["draft", "published"]);

/** present(row, false): a document without its body. */
export const documentSummarySchema = z.object({
  id: z.string().openapi({ description: "ULID" }),
  kind: documentKindSchema,
  folder: z.string(),
  title: z.string(),
  slug: z.string(),
  visibility: documentVisibilitySchema,
  status: documentStatusSchema.nullable(),
  post_id: z.number().int().nullable(),
  source: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number().int(),
});

/** present(row): a document with its body and frontmatter. */
export const documentSchema = documentSummarySchema.extend({
  body: z.string(),
  frontmatter: z.record(z.unknown()),
});

// Request only (POST and PUT /v1/documents): its descriptions are part of the Inbox guide.
export const documentInputSchema = z.object({
  kind: documentKindSchema.optional().openapi({
    description: "Defaults to note on create. On save, only note, journal and writing can change into each other. "
      + "Use POST /v1/links for a link and POST /v1/journal for a journal entry rather than these kinds",
  }),
  title: z.string().max(300).optional().openapi({ description: "Defaults to \"Untitled\" (a journal entry: its date)" }),
  body: z.string().max(1_000_000).optional().openapi({
    description: "Markdown. Photos go in as ![](url) with the url from POST /v1/documents/photos",
  }),
  folder: z.string().max(200).optional().openapi({
    description: "The folder's path, like \"Inbox\" or \"Library/Agent Skills\" (see GET /v1/sections). "
      + "\"\" is unsorted. Writing defaults to \"Writing\"",
  }),
  frontmatter: z.record(z.unknown()).optional().openapi({
    description: "Extra key/values kept with the document. On PUT, sending it replaces what is there (leave it out to keep it)",
  }),
  visibility: documentVisibilitySchema.optional().openapi({
    description: "Who it is for: private (only me, the default), agents (me and my agents), locked (journal). "
      + "Journal entries are always locked. Leave it out; public is set by publishing, never by hand",
  }),
  version: z.number().int().optional().openapi({
    description: "Required on PUT: the version you loaded (optimistic concurrency)",
  }),
});

export const linkSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  site: z.string().nullable(),
  excerpt: z.string().nullable(),
  reading_minutes: z.number().int().nullable(),
  read_at: z.string().nullable(),
  fetched_at: z.string().nullable(),
  image_url: z.string().nullable(),
  icon_url: z.string().nullable(),
  starred_at: z.string().nullable(),
  tags: z.array(z.string()),
  fetch_error: z.string().nullable(),
  visibility: documentVisibilitySchema,
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number().int(),
  state: z.enum(["inbox", "archived"]),
  archived_at: z.string().nullable(),
  kind: z.enum(["article", "video", "pdf", "post"]),
  progress: z.number().min(0).max(1),
  progress_anchor: z.string().nullable(),
  progress_updated_at: z.string().nullable(),
  progress_device: z.string().nullable(),
  opened_at: z.string().nullable(),
  note: z.string().nullable(),
  note_updated_at: z.string().nullable(),
  body: z.string().optional().openapi({ description: "The article as Markdown; only on single-link responses" }),
});

export const linkReadingSchema = z.object({
  progress: z.number().min(0).max(1),
  progress_anchor: z.string().nullable(),
  progress_updated_at: z.string().nullable(),
  progress_device: z.string().nullable(),
  opened_at: z.string().nullable(),
});
