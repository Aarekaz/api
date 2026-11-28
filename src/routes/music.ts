import { Hono } from "hono";
import { z } from "zod";
import {
  apiTags, authSecurity, cursorQuery, dateTimeSchema, musicNowResponseSchema, okResponses, openApiRegistry, pageFields, structuredOkResponses,
} from "../schemas/openapi";
import { cursorFrom, failWith, limitFrom, list, page } from "../lib/http";
import { getMusicNow, type MusicNowDependencies } from "../services/spotify/now-playing";
import type { Env } from "../types/env";

export function createMusicRoute(dependencies: MusicNowDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/now", async (c) => c.json(await getMusicNow(c.env, dependencies)));

  /** Every play kept so far, newest first. ?limit=100&before=ISO */
  app.get("/history", async (c) => {
    try {
      const limit = limitFrom(c, 100, 1000);
      const before = c.req.query("before");
      const until = before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : "9999";
      const after = cursorFrom(c, 2);
      // The page and the total don't depend on each other: one round trip (ADR 0012).
      const [plays, totals] = await c.env.DB.batch([
        c.env.DB.prepare(
          `SELECT * FROM music_plays WHERE played_at < ?${after ? " AND (played_at < ? OR (played_at = ? AND id < ?))" : ""}
           ORDER BY played_at DESC, id DESC LIMIT ?`,
        ).bind(until, ...(after ? [after[0], after[0], after[1]] : []), limit + 1),
        c.env.DB.prepare("SELECT COUNT(*) AS n, MIN(played_at) AS since FROM music_plays"),
      ]);
      const results = (plays.results ?? []) as Array<{ id: number; played_at: string }>;
      const total = (totals.results?.[0] ?? null) as Record<string, unknown> | null;
      const { items, next_cursor } = page(results, limit, (p) => [p.played_at, p.id]);
      return list(c, items, next_cursor, { total });
    } catch (error) {
      return failWith(c, error, "Music history request");
    }
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

// The Music guide agents read in /openapi.json; routes/spotify-integration.ts shares the tag.
const TAG = "Music";
apiTags.push({
  name: TAG,
  description: `What you listen to on Spotify: what's playing now, every play kept, and your top artists and tracks. \
Read-only: plays are kept by the server from Spotify's recently played list, so there is nothing to post.

**Public and private.** GET /v1/music/now is shown on anuragd.me (what's playing). History and top are private.

**Reading.** GET /v1/music/now for now; GET /v1/music/history pages through plays, newest first (\`cursor\`, or \`before\` a time); \
GET /v1/music/top?days= for the most played over recent days.

**Connecting Spotify** is the owner's to do, in a browser: POST /v1/integrations/spotify/connect returns a Spotify link to sign in \
with, and Spotify comes back to /integrations/spotify/callback. Don't start, finish or disconnect (DELETE /v1/integrations/spotify) \
the connection yourself. GET /v1/integrations/spotify says whether it's connected. No uploads here.`,
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/music/now",
  tags: [TAG],
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
  tags: [TAG],
  summary: "List kept Spotify plays, newest first",
  security: authSecurity,
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(1000).optional().openapi({ description: "Default 100" }),
      before: dateTimeSchema.optional().openapi({ description: "Only plays before this time" }),
      cursor: cursorQuery,
    }),
  },
  responses: structuredOkResponses(z.object({
    ...pageFields(musicPlaySchema),
    total: z.object({
      n: z.number().int().openapi({ description: "Plays kept in all" }),
      since: dateTimeSchema.nullable().openapi({ description: "The oldest play kept" }),
    }).nullable(),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/music/top",
  tags: [TAG],
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
