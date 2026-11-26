import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { cursorFrom, appErrors, fail as failWithStatus, later, limitFrom, list, page } from "../lib/http";
import { retryD1Read } from "../lib/d1-retry";
import { parseJson } from "../utils/json";
import {
  authSecurity,
  cursorQuery,
  pageFields,
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
import { DAY, dateOnly, isDay } from "../utils/date";

// /v1/links: read later. Every link lands in the Inbox; archiving it (when
// you've finished) moves it to the Archive. Progress and a note per article
// sync between devices. Deleting a link is DELETE /v1/documents/:id (soft, with
// restore). Every field added since v1 is additive, so older clients keep working.

const app = appErrors(new Hono<{ Bindings: Env }>(), "Links request");

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
  day: z.string().regex(DAY).nullish(),
  seconds: z.number().min(0).max(86_400).nullish().openapi({
    description: "Active reading seconds since this device's last report. Credited to time read (at most the time since the previous progress plus 30 s, and 10 minutes a report), even when progress didn't move.",
  }),
  words: z.number().int().min(0).max(5_000_000).nullish().openapi({
    description: "Words in the text the app rendered; raises the link's reading_minutes (230 words a minute) when it says more.",
  }),
  report_id: z.string().uuid().nullish().openapi({
    description: "The app's id for this report, so a retried request counts its seconds once.",
  }),
});

const ReadingStats = z.object({
  days: z.array(z.object({ day: z.string(), minutes: z.number(), articles: z.number() })),
  finished_by_month: z.array(z.object({ month: z.string(), count: z.number() })),
  top_sites: z.array(z.object({ site: z.string(), count: z.number() })),
  totals: z.object({ saved: z.number(), finished: z.number(), reading: z.number(), highlights: z.number() }),
  day: z.string().optional().openapi({ description: "The day asked for with ?day=, when given" }),
  articles: z.array(z.object({
    id: z.string(), title: z.string().nullable(), minutes: z.number(),
  })).optional().openapi({ description: "With ?day=: minutes per article read that day, in the order last read (the current one last)" }),
});

const SaveLink = z.object({ url: z.string().min(1).max(4000) });

/** One error shape, { error: { code, message } } (lib/http.ts). */

const invalidJson = (c: Context<{ Bindings: Env }>) => failWithStatus(c, 400, "Invalid JSON");

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
      cursor: cursorQuery,
    }),
  },
  responses: structuredOkResponses(z.object({
    links: z.array(linkSchema.omit({ body: true })).optional().openapi({ deprecated: true, description: "Deprecated: same as items, sent only while LEGACY_LIST_KEYS is on" }),
    ...pageFields(linkSchema.omit({ body: true })),
  })),
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
  request: { query: z.object({
    since: z.string().regex(DAY).optional().openapi({ description: "First day (default: a year ago)" }),
    day: z.string().regex(DAY).optional().openapi({ description: "Also list the articles read on this day, with their minutes" }),
  }) },
  responses: structuredOkResponses(ReadingStats),
});

for (const method of ["put", "post"] as const) {
  openApiRegistry.registerPath({
    method,
    path: "/v1/links/{id}/progress",
    summary: method === "put" ? "Save reading progress (last write wins by updated_at)" : "Save reading progress (same as PUT)",
    security: authSecurity,
    request: { params: idParams, body: openApiJsonRequestBody(Progress) },
    responses: structuredOkResponses(linkReadingSchema.extend({
      applied: z.boolean().openapi({ description: "Whether this write won" }),
    })),
  });
}

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
  path: "/v1/links/{id}/page",
  summary: "Read the article from a page the device fetched (for sites that block servers)",
  security: authSecurity,
  request: { params: idParams },
  responses: structuredOkResponses(fullLink),
});

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
  const limit = limitFrom(c, 500, 2000);
  const rows = await listLinks(c.env, state, limit, c.req.query("tag") || undefined, cursorFrom(c, 2) as [string, string] | null);
  const { items, next_cursor } = page(rows, limit, (row) => [row.created_at, row.id]);
  return list(c, "links", items.map((row) => presentLink(row)), next_cursor);
});

/** GET /v1/links/tags: every tag with how many links carry it (and how many are in the Inbox). */
app.get("/tags", async (c) => {
  return c.json({ items: await linkTags(c.env) });
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return failWithStatus(c, 400, "url is required");
  const { url } = SaveLink.parse(body);
  // The page is read after the reply (fetched_at null until then), so saving is instant.
  const link = await saveLink(c.env, url, new Date(), later(c));
  return c.json(presentLink(link, link.fetched_at !== null), 201);
});

app.get("/stats", async (c) => {
  const since = c.req.query("since");
  const day = isDay(since) ? since : dateOnly(new Date(Date.now() - 366 * 86_400_000));
  const on = c.req.query("day");
  const date = isDay(on) ? on : undefined;
  // D1 resets the whole database when any query (a backup tick, a sync) runs
  // out of CPU, failing these cheap reads with it; one retry nearly always lands.
  return c.json(await retryD1Read(() => readingStats(c.env, day, date)));
});

app.get("/:id", async (c) => {
  return c.json(presentLink(await getLink(c.env, c.req.param("id")), true));
});

/** PATCH /v1/links/:id { starred?, tags?, title?, state?, note? } */
app.patch("/:id", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return invalidJson(c);
  const id = c.req.param("id");
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
});

/** GET /v1/links/:id/progress: where you are, without the article's text. */
app.get("/:id/progress", async (c) => {
  return c.json(readingOf(await getLink(c.env, c.req.param("id"))));
});

/**
 * PUT (or POST) /v1/links/:id/progress { progress, anchor?, updated_at?, device?, day?, seconds?, words?, report_id? }:
 * last write wins by updated_at; seconds count as time read either way.
 */
app.on(["PUT", "POST"], "/:id/progress", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) return invalidJson(c);
  return c.json(await saveProgress(c.env, c.req.param("id"), Progress.parse(body)));
});

// Archive when you've finished; bring it back to the Inbox. /read and /unread are the older names.
for (const [path, archived] of [["archive", true], ["read", true], ["unarchive", false], ["unread", false]] as const) {
  app.post(`/:id/${path}`, async (c) => {
    return c.json(presentLink(await markRead(c.env, c.req.param("id"), archived)));
  });
}

/** POST /v1/links/:id/page {html, url}: the page as the device fetched it, for sites that turn the server away. */
app.post("/:id/page", async (c) => {
  const body = await c.req.json().catch(() => null) as { html?: unknown; url?: unknown } | null;
  if (!body || typeof body.html !== "string" || body.html.length < 200) return failWithStatus(c, 400, "html is required");
  const url = typeof body.url === "string" ? body.url : undefined;
  return c.json(presentLink(await fetchArticle(c.env, c.req.param("id"), new Date(), { html: body.html, url }), true));
});

app.post("/:id/refetch", async (c) => {
  return c.json(presentLink(await fetchArticle(c.env, c.req.param("id")), true));
});

export default app;
