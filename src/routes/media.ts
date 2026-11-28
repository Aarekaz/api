import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import {
  openApiRegistry,
  genericArraySchema,
  genericObjectSchema,
  structuredOkResponses,
  authSecurity,
} from "../schemas/openapi";
import { appErrors, fail } from "../lib/http";
import { getTmdbTvDetails, normalizeTmdbMediaType, searchTmdbMedia } from "../services/tmdb";

// TMDB lookups for adding to the shelf (the app and the web OS). Errors are the
// one shape (lib/http.ts).
const app = appErrors(new Hono<{ Bindings: Env }>(), "Media request");

const mediaSearchQuerySchema = z.object({
  type: z.enum(["movie", "show", "tv"]).openapi({ description: "movie, or show (tv is the same)" }),
  q: z.string().min(1).openapi({ description: "The title to look for" }),
  year: z.string().optional().openapi({ description: "Release year, to tell remakes apart" }),
});

// TMDB lookups are for adding to the shelf, so they share the Shelf tag (its guide is in routes/shelf.ts).
const TAG = "Shelf";

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/media/search",
  tags: [TAG],
  summary: "Search TMDB media",
  security: authSecurity,
  request: { query: mediaSearchQuerySchema },
  responses: structuredOkResponses(genericArraySchema),
});

/** TMDB's failure, as a 502 with what it said (the app shows it). */
const upstream = (c: Parameters<typeof fail>[0], error: unknown, fallback: string) =>
  fail(c, 502, error instanceof Error ? error.message : fallback);

app.get("/search", async (c) => {
  const validation = mediaSearchQuerySchema.safeParse(c.req.query());
  if (!validation.success) {
    return fail(c, 400, validation.error.issues[0]?.message ?? "Invalid query");
  }

  const type = normalizeTmdbMediaType(validation.data.type);
  if (!type) return fail(c, 400, "Invalid media type");

  try {
    return c.json(await searchTmdbMedia(c.env, { type, query: validation.data.q, year: validation.data.year }));
  } catch (error) {
    return upstream(c, error, "TMDB search failed");
  }
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/media/tv/{id}",
  tags: [TAG],
  summary: "A TMDB show's seasons and episode counts",
  security: authSecurity,
  request: { params: z.object({ id: z.string().openapi({ description: "The show's TMDB id, from /v1/media/search" }) }) },
  responses: structuredOkResponses(genericObjectSchema),
});

app.get("/tv/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return fail(c, 400, "Invalid id");
  try {
    const details = await getTmdbTvDetails(c.env, id);
    if (!details) return fail(c, 404, "Show not found");
    return c.json(details);
  } catch (error) {
    return upstream(c, error, "TMDB request failed");
  }
});

export default app;
