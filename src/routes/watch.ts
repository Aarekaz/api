import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { apiTags, authSecurity, genericObjectSchema, openApiRegistry, structuredOkResponses } from "../schemas/openapi";
import { appErrors, body, fail, list, ok, parse } from "../lib/http";
import { searchTmdbMedia, normalizeTmdbMediaType } from "../services/tmdb";
import {
  PICK_OUTCOMES,
  addTitle,
  cachedTitle,
  comingBack,
  library,
  logFilm,
  markEpisodes,
  recentPicks,
  recordPick,
  shelfIdsFor,
  stats,
  titleDetail,
  unmark,
  upNext,
} from "../services/watch";

// Films and shows: the tracker the apps use (services/watch.ts). App-only; the
// website keeps reading /v1/shelf, which these writes keep in step.
const app = appErrors(new Hono<{ Bindings: Env }>(), "Watch request");

const TAG = "Watch";
apiTags.push({
  name: TAG,
  description: `Films and shows, tracked episode by episode. Every viewing is a row with the time it happened (a film each \
time you see it, a show per episode); a second viewing is a rewatch and never replaces the first. TMDB's details (runtime, \
genres, seasons, episodes, air dates) are cached beside them and refreshed within six months, weekly for shows still airing.

**The shelf.** Each film or show is a shelf item (GET /v1/shelf), so anuragd.me shows it when it's published. Logging here \
moves the item (status, progress, dates, rating) and writes the diary's milestones (started, finished), like \
POST /v1/shelf/{id}/log. Titles added here are hidden unless \`published: true\` is sent.

**Order of calls.** GET /v1/watch/library once at launch (ETag). Search with GET /v1/watch/search, add with \
POST /v1/watch/titles. Log a film with POST /v1/watch/films/{id}/watched; an episode (or "everything up to S2E5") with \
POST /v1/watch/titles/{id}/episodes. A title's page (season grid) is GET /v1/watch/titles/{id}.

**Avoid.** Logging viewings the owner didn't tell you about. DELETE takes viewings back for good.`,
});

const id = (value: string) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return null;
  return number;
};

const itemParams = z.object({ id: z.string().openapi({ description: "The shelf item's id" }) });
const register = (method: "get" | "post" | "delete", path: string, summary: string, request: Record<string, unknown> = {}) =>
  openApiRegistry.registerPath({ method, path, tags: [TAG], summary, security: authSecurity, request, responses: structuredOkResponses(genericObjectSchema) });

// ---- Reads

register("get", "/v1/watch/library", "Every film and show with status, progress and what's next");
app.get("/library", async (c) => list(c, await library(c.env), null));

register("get", "/v1/watch/titles/{id}", "A title's details, episodes and viewings", { params: itemParams });
app.get("/titles/:id", async (c) => {
  const itemId = id(c.req.param("id"));
  if (!itemId) return fail(c, 400, "Invalid id");
  return ok(c, await titleDetail(c.env, itemId));
});

register("get", "/v1/watch/up-next", "The next episode of each show you're watching");
app.get("/up-next", async (c) => list(c, await upNext(c.env), null));

register("get", "/v1/watch/coming", "Air dates for the next episodes of shows you follow");
app.get("/coming", async (c) => list(c, await comingBack(c.env), null));

const statsQuery = z.object({ year: z.coerce.number().int().min(1900).max(2200).optional().openapi({ description: "Leave out for all time" }) });
register("get", "/v1/watch/stats", "A year in numbers: films, episodes, hours, months, genres", { query: statsQuery });
app.get("/stats", async (c) => ok(c, await stats(c.env, parse(statsQuery, c.req.query()).year)));

const searchQuery = z.object({
  q: z.string().trim().min(1).openapi({ description: "A title" }),
  type: z.enum(["movie", "show", "tv", "all"]).default("all"),
  year: z.string().optional(),
});
register("get", "/v1/watch/search", "Search TMDB; results already on the shelf carry their item_id", { query: searchQuery });
app.get("/search", async (c) => {
  const query = parse(searchQuery, c.req.query());
  const types = query.type === "all" ? (["movie", "tv"] as const) : ([normalizeTmdbMediaType(query.type)!] as const);
  const found = await Promise.all(types.map(async (type) => {
    const results = await searchTmdbMedia(c.env, { type, query: query.q, year: query.year, limit: 10 });
    const onShelf = await shelfIdsFor(c.env, type, results.map((result) => result.tmdb_id));
    return results.map((result) => ({ ...result, item_id: onShelf.get(result.tmdb_id) ?? null }));
  }));
  return list(c, found.flat().sort((a, b) => b.score - a.score), null);
});

register("get", "/v1/watch/picks", "What the picker offered lately");
app.get("/picks", async (c) => list(c, await recentPicks(c.env), null));

// ---- Writes

const addBody = z.object({
  media_type: z.enum(["movie", "tv", "show"]).optional(),
  tmdb_id: z.number().int().positive().optional(),
  tvdb_id: z.number().int().positive().optional(),
  imdb_id: z.string().regex(/^tt\d+$/).optional(),
  status: z.string().optional(),
  published: z.boolean().optional().openapi({ description: "Defaults to false: the title stays off anuragd.me" }),
  added_at: z.string().optional(),
  source: z.string().max(40).optional(),
  tags: z.array(z.string().max(120)).max(20).optional(),
});
register("post", "/v1/watch/titles", "Put a TMDB title on the shelf (or find it there)", { body: { content: { "application/json": { schema: addBody } } } });
app.post("/titles", async (c) => {
  const input = await body(c, addBody);
  const mediaType = input.media_type ? normalizeTmdbMediaType(input.media_type) ?? undefined : undefined;
  const { item, created } = await addTitle(c.env, { ...input, media_type: mediaType });
  return ok(c, { ...item, created }, created ? 201 : 200);
});

register("post", "/v1/watch/titles/{id}/refresh", "Fetch a title's TMDB details again now", { params: itemParams });
app.post("/titles/:id/refresh", async (c) => {
  const itemId = id(c.req.param("id"));
  if (!itemId) return fail(c, 400, "Invalid id");
  const detail = await titleDetail(c.env, itemId);
  if (detail.tmdb?.id && detail.tmdb.media_type) await cachedTitle(c.env, detail.tmdb.media_type, detail.tmdb.id, { force: true, episodes: true });
  return ok(c, await titleDetail(c.env, itemId));
});

const episodeMark = z.object({
  season: z.number().int().min(0),
  episode: z.number().int().positive(),
  watched_at: z.string().optional(),
  source_key: z.string().max(200).optional(),
  skipped: z.boolean().optional(),
  rating: z.number().min(0.5).max(5).multipleOf(0.5).optional(),
});
const markBody = z.object({
  episodes: z.array(episodeMark).max(2000).optional(),
  up_to: z.object({ season: z.number().int().min(0), episode: z.number().int().positive() }).optional(),
  watched_at: z.string().optional(),
  rewatch: z.boolean().optional(),
  update_item: z.boolean().optional().openapi({ description: "false for an import of old viewings: the shelf item and diary stay as they are" }),
  source: z.string().max(40).optional(),
  run: z.number().int().min(0).max(50).optional(),
});
register("post", "/v1/watch/titles/{id}/episodes", "Mark episodes watched or skipped (or everything up to one)", {
  params: itemParams,
  body: { content: { "application/json": { schema: markBody } } },
});
app.post("/titles/:id/episodes", async (c) => {
  const itemId = id(c.req.param("id"));
  if (!itemId) return fail(c, 400, "Invalid id");
  const result = await markEpisodes(c.env, itemId, await body(c, markBody));
  return ok(c, result, result.added > 0 ? 201 : 200);
});

const watchIds = z.object({ ids: z.string().openapi({ description: "Viewing ids, comma-separated (at most 90)" }) });
register("delete", "/v1/watch/titles/{id}/watches", "Take viewings back", { params: itemParams, query: watchIds });
app.delete("/titles/:id/watches", async (c) => {
  const itemId = id(c.req.param("id"));
  if (!itemId) return fail(c, 400, "Invalid id");
  const ids = parse(watchIds, c.req.query()).ids.split(",").map((value) => id(value.trim()));
  if (!ids.length || ids.length > 90 || ids.some((value) => value == null)) return fail(c, 400, "Send 1 to 90 viewing ids");
  return ok(c, await unmark(c.env, itemId, ids as number[]));
});

const filmBody = z.object({
  watched_at: z.string().optional().openapi({ description: "A day or a moment; now when left out" }),
  rating: z.number().min(0.5).max(5).multipleOf(0.5).nullable().optional(),
  note: z.string().max(2000).optional(),
  source: z.string().max(40).optional(),
  source_key: z.string().max(200).optional(),
  update_item: z.boolean().optional(),
});
register("post", "/v1/watch/films/{id}/watched", "Log a viewing of a film (a second one is a rewatch)", {
  params: itemParams,
  body: { content: { "application/json": { schema: filmBody } } },
});
app.post("/films/:id/watched", async (c) => {
  const itemId = id(c.req.param("id"));
  if (!itemId) return fail(c, 400, "Invalid id");
  const result = await logFilm(c.env, itemId, await body(c, filmBody));
  return ok(c, result, result.added > 0 ? 201 : 200);
});

const pickBody = z.object({ item_id: z.number().int().positive(), outcome: z.enum(PICK_OUTCOMES) });
register("post", "/v1/watch/picks", "Record what the picker landed on, and what came of it", {
  body: { content: { "application/json": { schema: pickBody } } },
});
app.post("/picks", async (c) => {
  const input = await body(c, pickBody);
  return ok(c, await recordPick(c.env, input.item_id, input.outcome), 201);
});

export default app;
