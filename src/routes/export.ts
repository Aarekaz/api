import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import {
  normalizeProfile,
  normalizeSettings,
  normalizeProject,
  normalizeNote,
  normalizeEvent,
  normalizePost,
  normalizeShelfItem,
  normalizeSkill,
  normalizePhoto,
  normalizeStatusSnapshot,
  normalizeWakaTimeHourly,
} from "../utils/normalizers";
import {
  openApiRegistry,
  genericObjectSchema,
  okResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registration
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/export",
  summary: "Export all data",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

// Route handler
app.get("/", async (c) => {
  const [
    profile,
    nowState,
    settings,
    projects,
    notes,
    events,
    posts,
    usesItems,
    shelfItems,
    experience,
    education,
    skills,
    photos,
    statusSnapshots,
    wakaDays,
    wakaLanguages,
    wakaProjects,
    wakaEditors,
    wakaHourly,
    githubDaily,
    githubRepos,
  ] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM profile WHERE id = 1").all(),
    c.env.DB.prepare("SELECT * FROM now_state WHERE id = 1").all(),
    c.env.DB.prepare("SELECT * FROM settings WHERE id = 1").all(),
    c.env.DB.prepare("SELECT * FROM projects ORDER BY created_at DESC").all(),
    c.env.DB.prepare("SELECT * FROM notes ORDER BY created_at DESC").all(),
    c.env.DB.prepare("SELECT * FROM events ORDER BY occurred_at DESC").all(),
    c.env.DB.prepare("SELECT * FROM posts ORDER BY published_at DESC").all(),
    c.env.DB.prepare("SELECT * FROM uses ORDER BY category, name").all(),
    c.env.DB.prepare("SELECT * FROM shelf ORDER BY date_added DESC").all(),
    c.env.DB.prepare("SELECT * FROM experience ORDER BY start_date DESC").all(),
    c.env.DB.prepare("SELECT * FROM education ORDER BY start_date DESC").all(),
    c.env.DB.prepare("SELECT * FROM skills ORDER BY category").all(),
    c.env.DB.prepare("SELECT * FROM photos ORDER BY shot_at DESC, created_at DESC").all(),
    c.env.DB.prepare(
      "SELECT * FROM status_snapshots ORDER BY created_at DESC"
    ).all(),
    c.env.DB.prepare("SELECT * FROM wakatime_days ORDER BY date ASC").all(),
    c.env.DB.prepare(
      "SELECT * FROM wakatime_languages ORDER BY date ASC, total_seconds DESC"
    ).all(),
    c.env.DB.prepare(
      "SELECT * FROM wakatime_projects ORDER BY date ASC, total_seconds DESC"
    ).all(),
    c.env.DB.prepare(
      "SELECT * FROM wakatime_editors ORDER BY date ASC, total_seconds DESC"
    ).all(),
    c.env.DB.prepare(
      "SELECT * FROM wakatime_hourly ORDER BY date ASC, hour ASC"
    ).all(),
    c.env.DB.prepare("SELECT * FROM github_daily ORDER BY date ASC").all(),
    c.env.DB.prepare(
      "SELECT * FROM github_repo_totals ORDER BY range_start ASC, count DESC"
    ).all(),
  ]);

  return c.json({
    profile: profile.results[0]
      ? normalizeProfile(profile.results[0] as JsonRecord)
      : {},
    now: nowState.results[0] ?? {},
    settings: settings.results[0]
      ? normalizeSettings(settings.results[0] as JsonRecord)
      : {},
    projects: (projects.results ?? []).map((row) =>
      normalizeProject(row as JsonRecord)
    ),
    notes: (notes.results ?? []).map((row) => normalizeNote(row as JsonRecord)),
    events: (events.results ?? []).map((row) =>
      normalizeEvent(row as JsonRecord)
    ),
    posts: (posts.results ?? []).map((row) =>
      normalizePost(row as JsonRecord)
    ),
    uses: usesItems.results ?? [],
    shelf: (shelfItems.results ?? []).map((row) =>
      normalizeShelfItem(row as JsonRecord)
    ),
    experience: experience.results ?? [],
    education: education.results ?? [],
    skills: (skills.results ?? []).map((row) =>
      normalizeSkill(row as JsonRecord)
    ),
    photos: (photos.results ?? []).map((row) =>
      normalizePhoto(row as JsonRecord)
    ),
    status: (statusSnapshots.results ?? []).map((row) =>
      normalizeStatusSnapshot(row as JsonRecord)
    ),
    wakatime: {
      days: wakaDays.results ?? [],
      languages: wakaLanguages.results ?? [],
      projects: wakaProjects.results ?? [],
      editors: wakaEditors.results ?? [],
      hourly: (wakaHourly.results ?? []).map((row) =>
        normalizeWakaTimeHourly(row as JsonRecord)
      ),
    },
    github: {
      daily: githubDaily.results ?? [],
      repos: githubRepos.results ?? [],
    },
  });
});

export default app;
