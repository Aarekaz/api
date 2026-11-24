import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import {
  openApiRegistry,
  genericArraySchema,
  genericObjectSchema,
  okResponses,
  authSecurity,
} from "../schemas/openapi";
import { getTmdbTvDetails, normalizeTmdbMediaType, searchTmdbMedia } from "../services/tmdb";

const app = new Hono<{ Bindings: Env }>();

const mediaSearchQuerySchema = z.object({
  type: z.enum(["movie", "show", "tv"]),
  q: z.string().min(1),
  year: z.string().optional(),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/media/search",
  summary: "Search TMDB media",
  security: authSecurity,
  request: { query: mediaSearchQuerySchema },
  responses: okResponses(genericArraySchema),
});

app.get("/search", async (c) => {
  const query = c.req.query();
  const validation = mediaSearchQuerySchema.safeParse(query);
  if (!validation.success) {
    return c.json({ error: validation.error.issues[0]?.message ?? "Invalid query" }, 400);
  }

  const type = normalizeTmdbMediaType(validation.data.type);
  if (!type) {
    return c.json({ error: "Invalid media type" }, 400);
  }

  try {
    const candidates = await searchTmdbMedia(c.env, {
      type,
      query: validation.data.q,
      year: validation.data.year,
    });
    return c.json(candidates);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "TMDB search failed" },
      502
    );
  }
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/media/tv/{id}",
  summary: "A TMDB show's seasons and episode counts",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

app.get("/tv/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "Invalid id" }, 400);
  }
  try {
    const details = await getTmdbTvDetails(c.env, id);
    if (!details) return c.json({ error: "Show not found" }, 404);
    return c.json(details);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "TMDB request failed" },
      502
    );
  }
});

export default app;
