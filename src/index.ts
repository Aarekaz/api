import { Hono } from "hono";
import type { Env } from "./types/env";
import { nowIso } from "./utils/date";
import { requireAuth } from "./middleware/auth";
import { getOpenApiDocument } from "./schemas/openapi";
import { handleScheduled } from "./scheduled";

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
import statusRoute from "./routes/status";
import wakatimeRoute from "./routes/wakatime";
import githubRoute from "./routes/github";
import wrappedRoute from "./routes/wrapped";
import refreshRoute from "./routes/refresh";
import exportRoute from "./routes/export";
import healthDataRoute from "./routes/health-data";

const app = new Hono<{ Bindings: Env }>();

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

app.get("/openapi.json", (c) => {
  return c.json(getOpenApiDocument(c.env.API_VERSION));
});

// Health check (requires auth)
app.use("/health", requireAuth);
app.route("/health", healthRoute);

// Protected v1 routes
app.use("/v1/*", requireAuth);
app.route("/v1/profile", profileRoute);
app.route("/v1/now", nowRoute);
app.route("/v1/settings", settingsRoute);
app.route("/v1/projects", projectsRoute);
app.route("/v1/notes", notesRoute);
app.route("/v1/events", eventsRoute);
app.route("/v1/posts", postsRoute);
app.route("/v1/uses", usesRoute);
app.route("/v1/shelf", shelfRoute);
app.route("/v1/experience", experienceRoute);
app.route("/v1/education", educationRoute);
app.route("/v1/skills", skillsRoute);
app.route("/v1/photos", photosRoute);
app.route("/v1/status", statusRoute);
app.route("/v1/wakatime", wakatimeRoute);
app.route("/v1/github", githubRoute);
app.route("/v1/wrapped", wrappedRoute);
app.route("/v1/refresh", refreshRoute);
app.route("/v1/export", exportRoute);
app.route("/v1/health", healthDataRoute);

// Export Cloudflare Worker handlers
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return app.fetch(request, env);
  },
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    return handleScheduled(event, env);
  },
};
