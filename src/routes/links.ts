import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { DocumentError } from "../services/documents";
import {
  authSecurity,
  openApiJsonRequestBody,
  openApiRegistry,
  structuredCreatedResponses,
  structuredOkResponses,
} from "../schemas/openapi";
import { linkReadingSchema, linkSchema } from "../schemas/documents";
import {
  fetchArticle, getLink, linkTags, listLinks, markRead, presentLink, readingOf, readingStats, saveLink, saveProgress, setLinkNote, updateLink,
  type LinkListState,
} from "../services/links";

// /v1/links: read later. Every link lands in the Inbox; archiving it (when
// you've finished) moves it to the Archive. Progress and a note per article
// sync between devices. Deleting a link is DELETE /v1/documents/:id (soft, with
// restore). Every field added since v1 is additive, so older clients keep working.

const app = new Hono<{ Bindings: Env }>();

const STATES = ["unread", "read", "starred", "all", "inbox", "archived"] as const;
const Tag = z.string().trim().max(40).transform((t) => t.replace(/^#+/, "").toLowerCase());

const UpdateLink = z.object({
  starred: z.boolean().optional(),
  tags: z.array(Tag).max(30).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  state: z.enum(["inbox", "archived"]).optional(),
  note: z.string().max(20_000).nullable().optional(),
});

const Progress = z.object({
  progress: z.number().min(0).max(1),
  anchor: z.string().max(500).nullish(),
  /** When you were there (the device's clock), for last-write-wins. Defaults to now. */
  updated_at: z.string().datetime({ offset: true }).optional(),
  device: z.string().trim().max(60).nullish(),
  /** The device's local date, so time read lands on the day you read it. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

const ReadingStats = z.object({
  days: z.array(z.object({ day: z.string(), minutes: z.number(), articles: z.number() })),
  finished_by_month: z.array(z.object({ month: z.string(), count: z.number() })),
  top_sites: z.array(z.object({ site: z.string(), count: z.number() })),
  totals: z.object({ saved: z.number(), finished: z.number(), reading: z.number(), highlights: z.number() }),
});

const SaveLink = z.object({ url: z.string().min(1).max(4000) });

/** One error shape: { error: { code, message } }. */
function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof z.ZodError) {
    return c.json({ error: { code: "invalid", message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
  }
  if (error instanceof DocumentError) {
    const code = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid";
    return c.json({ error: { code, message: error.message } }, error.status);
  }
  console.error("links route failed", error);
  return c.json({ error: { code: "server", message: "Links request failed" } }, 500);
}

const invalidJson = (c: Context<{ Bindings: Env }>) => c.json({ error: { code: "invalid", message: "Invalid JSON" } }, 400);

// OpenAPI registrations
const idParams = z.object({ id: z.string().openapi({ description: "The link's document id" }) });
const fullLink = linkSchema.required({ body: true });

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/links",
  summary: "List saved links, newest first",
  security: authSecurity,
  request: {
    query: z.object({
      state: z.enum(STATES).optional().openapi({ description: "inbox, archived, starred or all (default); unread/read are older names" }),
      tag: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(2000).optional().openapi({ description: "Default 500" }),
    }),
  },
  responses: structuredOkResponses(z.object({ links: z.array(linkSchema.omit({ body: true })) })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/links/tags",
  summary: "List link tags with how many links carry each",
  security: authSecurity,
  responses: structuredOkResponses(z.object({
    items: z.array(z.object({
      tag: z.string(),
      count: z.number().int(),
      inbox: z.number().int().openapi({ description: "How many of those are in the Inbox" }),
    })),
  })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/links",
  summary: "Save a link to Read later",
  description: "Fetches the article once and keeps it as Markdown.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(SaveLink) },
  responses: structuredCreatedResponses(fullLink),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/links/{id}",
  summary: "Get a link with its article",
  security: authSecurity,
  request: { params: idParams },
  responses: structuredOkResponses(fullLink),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/links/{id}",
  summary: "Update a link (star, tags, title, state, note)",
  security: authSecurity,
  request: { params: idParams, body: openApiJsonRequestBody(UpdateLink) },
  responses: structuredOkResponses(linkSchema.omit({ body: true })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/links/{id}/progress",
  summary: "Get reading progress",
  security: authSecurity,
  request: { params: idParams },
  responses: structuredOkResponses(linkReadingSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/links/stats",
  summary: "Reading stats: minutes and articles per day, finished per month, favourite sites",
  security: authSecurity,
  request: { query: z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: "First day (default: a year ago)" }) }) },
  responses: structuredOkResponses(ReadingStats),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/links/{id}/progress",
  summary: "Save reading progress (last write wins by updated_at)",
  security: authSecurity,
  request: { params: idParams, body: openApiJsonRequestBody(Progress) },
  responses: structuredOkResponses(linkReadingSchema.extend({
    applied: z.boolean().openapi({ description: "Whether this write won" }),
  })),
});

for (const [action, summary] of [
  ["archive", "Archive a link"],
  ["read", "Archive a link (older name for archive)"],
  ["unarchive", "Move a link back to the Inbox"],
  ["unread", "Move a link back to the Inbox (older name for unarchive)"],
] as const) {
  openApiRegistry.registerPath({
    method: "post",
    path: `/v1/links/{id}/${action}`,
    summary,
    security: authSecurity,
    request: { params: idParams },
    responses: structuredOkResponses(linkSchema.omit({ body: true })),
  });
}

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/links/{id}/refetch",
  summary: "Fetch the article again",
  security: authSecurity,
  request: { params: idParams },
  responses: structuredOkResponses(fullLink),
});

/** GET /v1/links?state=inbox|archived|starred|all (unread/read still work)&tag=&limit= */
app.get("/", async (c) => {
  const raw = c.req.query("state");
  const state: LinkListState = (STATES as readonly string[]).includes(raw ?? "") ? raw as LinkListState : "all";
  try {
    const rows = await listLinks(c.env, state, Number(c.req.query("limit")) || undefined, c.req.query("tag") || undefined);
    return c.json({ links: rows.map((row) => presentLink(row)) });
  } catch (error) {
    return fail(c, error);
  }
});

/** GET /v1/links/tags: every tag with how many links carry it (and how many are in the Inbox). */
app.get("/tags", async (c) => {
  try {
    return c.json({ items: await linkTags(c.env) });
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return c.json({ error: { code: "invalid", message: "url is required" } }, 400);
  try {
    const { url } = SaveLink.parse(body);
    return c.json(presentLink(await saveLink(c.env, url), true), 201);
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/stats", async (c) => {
  const since = c.req.query("since");
  const day = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10);
  return c.json(await readingStats(c.env, day));
});

app.get("/:id", async (c) => {
  try {
    return c.json(presentLink(await getLink(c.env, c.req.param("id")), true));
  } catch (error) {
    return fail(c, error);
  }
});

/** PATCH /v1/links/:id { starred?, tags?, title?, state?, note? } */
app.patch("/:id", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return invalidJson(c);
  const id = c.req.param("id");
  try {
    const input = UpdateLink.parse(body);
    const current = await getLink(c.env, id);
    if (input.starred !== undefined || input.tags !== undefined || input.title !== undefined) {
      await updateLink(c.env, id, { starred: input.starred, tags: input.tags, title: input.title });
    }
    if (input.state && (input.state === "archived") !== (current.read_at !== null)) {
      await markRead(c.env, id, input.state === "archived");
    }
    if (input.note !== undefined) await setLinkNote(c.env, id, input.note);
    return c.json(presentLink(await getLink(c.env, id)));
  } catch (error) {
    return fail(c, error);
  }
});

/** GET /v1/links/:id/progress: where you are, without the article's text. */
app.get("/:id/progress", async (c) => {
  try {
    return c.json(readingOf(await getLink(c.env, c.req.param("id"))));
  } catch (error) {
    return fail(c, error);
  }
});

/** PUT /v1/links/:id/progress { progress, anchor?, updated_at?, device? }: last write wins by updated_at. */
app.put("/:id/progress", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return invalidJson(c);
  try {
    return c.json(await saveProgress(c.env, c.req.param("id"), Progress.parse(body)));
  } catch (error) {
    return fail(c, error);
  }
});

// Archive when you've finished; bring it back to the Inbox. /read and /unread are the older names.
for (const [path, archived] of [["archive", true], ["read", true], ["unarchive", false], ["unread", false]] as const) {
  app.post(`/:id/${path}`, async (c) => {
    try {
      return c.json(presentLink(await markRead(c.env, c.req.param("id"), archived)));
    } catch (error) {
      return fail(c, error);
    }
  });
}

app.post("/:id/refetch", async (c) => {
  try {
    return c.json(presentLink(await fetchArticle(c.env, c.req.param("id")), true));
  } catch (error) {
    return fail(c, error);
  }
});

export default app;
