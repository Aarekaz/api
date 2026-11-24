import { Hono } from "hono";
import type { Env } from "./types/env";
import { nowIso } from "./utils/date";
import { requireAuth } from "./middleware/auth";
import { errorHandler } from "./middleware/error-handler";
import { requestLogger } from "./middleware/request-logger";
import { getOpenApiDocument } from "./schemas/openapi";
import { getSwaggerUiHtml } from "./utils/swagger";
import { handleScheduled } from "./scheduled";
import { syncMusicPlays } from "./services/spotify/history";
import { handleWhoopQueue } from "./services/whoop/sync";
import type { WhoopQueueMessage } from "./types/whoop";

// Import route modules
import healthRoute from "./routes/health";
import profileRoute from "./routes/profile";
import nowRoute from "./routes/now";
import settingsRoute from "./routes/settings";
import projectsRoute from "./routes/projects";
import notesRoute from "./routes/notes";
import eventsRoute from "./routes/events";
import postsRoute from "./routes/posts";
import usesRoute from "./routes/uses";
import shelfRoute from "./routes/shelf";
import experienceRoute from "./routes/experience";
import educationRoute from "./routes/education";
import skillsRoute from "./routes/skills";
import photosRoute from "./routes/photos";
import blogImagesRoute from "./routes/blog-images";
import statusRoute from "./routes/status";
import wakatimeRoute from "./routes/wakatime";
import githubRoute from "./routes/github";
import wrappedRoute from "./routes/wrapped";
import trafficRoute from "./routes/traffic";
import refreshRoute from "./routes/refresh";
import exportRoute from "./routes/export";
import healthDataRoute from "./routes/health-data";
import locationRoute from "./routes/location";
import customRoute from "./routes/custom";
import logsRoute from "./routes/logs";
import mediaRoute from "./routes/media";
import financeRoute from "./routes/finance";
import crowdRoute from "./routes/crowd";
import whoopIntegrationRoute from "./routes/whoop-integration";
import whoopHealthRoute from "./routes/whoop-health";
import spotifyIntegrationRoute from "./routes/spotify-integration";
import musicRoute from "./routes/music";
import vaultRoute from "./routes/vault";
import appAuthRoute, { signOutRoute } from "./routes/app-auth";
import documentsRoute, { searchRoute, captureRoute } from "./routes/documents";
import syncStatusRoute from "./routes/sync-status";
import linksRoute from "./routes/links";
import journalRoute from "./routes/journal";
import highlightsRoute from "./routes/highlights";
import visitsRoute from "./routes/visits";
import trainingRoute from "./routes/training";
import recipesRoute from "./routes/recipes";
import sectionsRoute from "./routes/sections";
import siteRoute from "./routes/site";
import { maybeRunVaultBackup } from "./services/backup";

const app = new Hono<{ Bindings: Env }>();

// Global middleware (applied to all routes)
app.use("*", requestLogger);
app.use("*", errorHandler);

// CORS for presigned upload — middleware adds headers to ALL responses on this path
const PRESIGNED_UPLOAD_PATHS = [
  "/v1/photos/upload-presigned",
  "/v1/blog-images/upload-presigned",
];
for (const path of PRESIGNED_UPLOAD_PATHS) {
  app.use(path, async (c, next) => {
    // Handle preflight
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Upload-Token",
          "Access-Control-Max-Age": "600",
        },
      });
    }

    // Run the handler, then add CORS headers to whatever it returns
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "*");
  });
}

// CORS for the public crowd endpoint — the living-world site (aarekaz.me) reads
// and records visits from the browser, cross-origin.
app.use("/v1/crowd", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  await next();
  c.res.headers.set("Access-Control-Allow-Origin", "*");
});

// Public routes
app.get("/", (c) => {
  const version = c.env.API_VERSION ?? "unknown";
  return c.json({
    title: "Personal API",
    author: "Anurag Dhungana",
    website: "https://www.anuragd.me",
    version,
    status: "ok",
    timestamp: nowIso(),
    schemaVersion: 1,
    label: "api",
    message: version,
    color: "blue",
  });
});

// Shields.io badge endpoint (returns only the required fields)
app.get("/badge", (c) => {
  const version = c.env.API_VERSION ?? "unknown";
  return c.json({
    schemaVersion: 1,
    label: "api",
    message: version,
    color: "blue",
  });
});

app.get("/openapi.json", (c) => {
  return c.json(getOpenApiDocument(c.env.API_VERSION, c.env.API_BASE_URL));
});

// API documentation (public - authorize within Swagger UI to test endpoints)
app.get("/docs", (c) => {
  const openapiUrl = `${c.env.API_BASE_URL || ''}/openapi.json`;
  return c.html(getSwaggerUiHtml(openapiUrl));
});

// Sign in with GitHub for the native apps (public; issues device sessions)
app.route("/auth/app", appAuthRoute);

// Health check (requires auth)
app.use("/health", requireAuth);
app.route("/health", healthRoute);

// Protected v1 routes
app.use("/v1/*", requireAuth);
app.route("/", whoopIntegrationRoute);
app.route("/", spotifyIntegrationRoute);
app.route("/v1/profile", profileRoute);
app.route("/v1/now", nowRoute);
app.route("/v1/settings", settingsRoute);
app.route("/v1/projects", projectsRoute);
app.route("/v1/notes", notesRoute);
app.route("/v1/events", eventsRoute);
app.route("/v1/posts", postsRoute);
app.route("/v1/uses", usesRoute);
app.route("/v1/shelf", shelfRoute);
app.route("/v1/media", mediaRoute);
app.route("/v1/experience", experienceRoute);
app.route("/v1/education", educationRoute);
app.route("/v1/skills", skillsRoute);
app.route("/v1/photos", photosRoute);
app.route("/v1/blog-images", blogImagesRoute);
app.route("/v1/status", statusRoute);
app.route("/v1/wakatime", wakatimeRoute);
app.route("/v1/github", githubRoute);
app.route("/v1/wrapped", wrappedRoute);
app.route("/v1/traffic", trafficRoute);
app.route("/v1/refresh", refreshRoute);
app.route("/v1/export", exportRoute);
app.route("/v1/health/whoop", whoopHealthRoute);
app.route("/v1/health", healthDataRoute);
app.route("/v1/location", locationRoute);
app.route("/v1/custom", customRoute);
app.route("/v1/logs", logsRoute);
app.route("/v1/finance", financeRoute);
app.route("/v1/music", musicRoute);
app.route("/v1/vault", vaultRoute);
app.route("/v1/app/signout", signOutRoute);
app.route("/v1/documents", documentsRoute);
app.route("/v1/search", searchRoute);
app.route("/v1/capture", captureRoute);
app.route("/v1/sync/status", syncStatusRoute);
app.route("/v1/links", linksRoute);
app.route("/v1/journal", journalRoute);
app.route("/v1/highlights", highlightsRoute);
app.route("/v1/visits", visitsRoute);
app.route("/v1/training", trainingRoute);
app.route("/v1/recipes", recipesRoute);
app.route("/v1/sections", sectionsRoute);
app.route("/v1/site", siteRoute);
app.route("/v1/crowd", crowdRoute); // public — un-gated via AUTH_SKIP_PATHS

// Export Cloudflare Worker handlers
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return app.fetch(request, env);
  },
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await handleScheduled(event, env);
    await maybeRunVaultBackup(env, new Date(event.scheduledTime));
    // Spotify forgets after 50 plays; keep them every half hour.
    if (new Date(event.scheduledTime).getUTCMinutes() % 30 < 5) {
      try { await syncMusicPlays(env); } catch (error) { console.error("music history sync failed", error); }
    }
  },
  async queue(batch: MessageBatch<WhoopQueueMessage>, env: Env): Promise<void> {
    return handleWhoopQueue(batch, env);
  },
};
