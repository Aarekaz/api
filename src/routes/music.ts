import { Hono } from "hono";
import { authSecurity, musicNowResponseSchema, okResponses, openApiRegistry } from "../schemas/openapi";
import { getMusicNow, type MusicNowDependencies } from "../services/spotify/now-playing";
import type { Env } from "../types/env";

export function createMusicRoute(dependencies: MusicNowDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/now", async (c) => c.json(await getMusicNow(c.env, dependencies)));

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
