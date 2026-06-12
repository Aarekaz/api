import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import {
  openApiRegistry,
  genericArraySchema,
  okResponses,
  authSecurity,
} from "../schemas/openapi";
import { normalizeTmdbMediaType, searchTmdbMedia } from "../services/tmdb";

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

export default app;
