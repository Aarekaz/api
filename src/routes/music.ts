import { Hono } from "hono";
import { z } from "zod";
import { authSecurity, dateTimeSchema, musicNowResponseSchema, okResponses, openApiRegistry } from "../schemas/openapi";
import { getMusicNow, type MusicNowDependencies } from "../services/spotify/now-playing";
import type { Env } from "../types/env";

export function createMusicRoute(dependencies: MusicNowDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/now", async (c) => c.json(await getMusicNow(c.env, dependencies)));

  /** Every play kept so far, newest first. ?limit=100&before=ISO */
  app.get("/history", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 1000);
    const before = c.req.query("before");
    const until = before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : "9999";
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM music_plays WHERE played_at < ? ORDER BY played_at DESC LIMIT ?",
    ).bind(until, limit).all();
    const total = await c.env.DB.prepare("SELECT COUNT(*) AS n, MIN(played_at) AS since FROM music_plays").first();
    return c.json({ plays: results, total });
  });

  /** What you listened to most. ?days=30 */
  app.get("/top", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 3650);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [artists, tracks, totals] = await Promise.all([
      c.env.DB.prepare(
        `SELECT artists AS name, COUNT(*) AS plays, MAX(image_url) AS image_url FROM music_plays
         WHERE played_at >= ? AND artists IS NOT NULL GROUP BY artists ORDER BY plays DESC LIMIT 10`,
      ).bind(since).all(),
      c.env.DB.prepare(
        `SELECT track, artists, MAX(image_url) AS image_url, MAX(url) AS url, COUNT(*) AS plays FROM music_plays
         WHERE played_at >= ? GROUP BY track_id ORDER BY plays DESC LIMIT 10`,
      ).bind(since).all(),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS plays, CAST(COALESCE(SUM(duration_ms), 0) / 60000 AS INTEGER) AS minutes FROM music_plays WHERE played_at >= ?",
      ).bind(since).first(),
    ]);
    return c.json({ days, artists: artists.results, tracks: tracks.results, ...(totals ?? {}) });
  });

  return app;
}

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/music/now",
  summary: "Get the currently playing or most recently played Spotify track",
  description: "Served from a ~25 second cache. Returns `disconnected` (HTTP 200) when Spotify is not connected; "
    + "on Spotify rate limits or failures the last cached result (or `idle`) is returned.",
  security: authSecurity,
  responses: okResponses(musicNowResponseSchema),
});

/** A row of music_plays. */
const musicPlaySchema = z.object({
  id: z.number().int(),
  played_at: dateTimeSchema,
  track_id: z.string(),
  track: z.string(),
  artists: z.string().nullable(),
  album: z.string().nullable(),
  image_url: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  url: z.string().nullable(),
  created_at: dateTimeSchema,
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/music/history",
  summary: "List kept Spotify plays, newest first",
  security: authSecurity,
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(1000).optional().openapi({ description: "Default 100" }),
      before: dateTimeSchema.optional().openapi({ description: "Only plays before this time" }),
    }),
  },
  responses: okResponses(z.object({
    plays: z.array(musicPlaySchema),
    total: z.object({
      n: z.number().int().openapi({ description: "Plays kept in all" }),
      since: dateTimeSchema.nullable().openapi({ description: "The oldest play kept" }),
    }).nullable(),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/music/top",
  summary: "Get top artists and tracks over recent days",
  security: authSecurity,
  request: {
    query: z.object({
      days: z.coerce.number().int().min(1).max(3650).optional().openapi({ description: "Default 30" }),
    }),
  },
  responses: okResponses(z.object({
    days: z.number().int(),
    artists: z.array(z.object({
      name: z.string(),
      plays: z.number().int(),
      image_url: z.string().nullable(),
    })),
    tracks: z.array(z.object({
      track: z.string(),
      artists: z.string().nullable(),
      image_url: z.string().nullable(),
      url: z.string().nullable(),
      plays: z.number().int(),
    })),
    plays: z.number().int().optional(),
    minutes: z.number().int().optional(),
  })),
});

export default createMusicRoute();
