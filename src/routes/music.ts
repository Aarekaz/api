import { Hono } from "hono";
import { authSecurity, musicNowResponseSchema, okResponses, openApiRegistry } from "../schemas/openapi";
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

export default createMusicRoute();
