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
    whoopProfiles,
    whoopBodyMeasurements,
    whoopCycles,
    whoopRecoveries,
    whoopSleeps,
    whoopWorkouts,
  ] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM profile WHERE id = 1").all(),
    c.env.DB.prepare("SELECT * FROM now_state WHERE id = 1").all(),
    c.env.DB.prepare("SELECT * FROM settings WHERE id = 1").all(),
    c.env.DB.prepare("SELECT * FROM projects ORDER BY created_at DESC").all(),
    c.env.DB.prepare("SELECT * FROM notes ORDER BY created_at DESC").all(),
    c.env.DB.prepare("SELECT * FROM events ORDER BY occurred_at DESC").all(),
    c.env.DB.prepare("SELECT * FROM posts ORDER BY published_at DESC").all(),
    c.env.DB.prepare("SELECT * FROM uses_items ORDER BY category, name").all(),
    c.env.DB.prepare("SELECT * FROM shelf_items ORDER BY date_added DESC").all(),
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
    c.env.DB.prepare(`
      SELECT whoop_user_id, first_name, last_name, email,
             upstream_created_at, upstream_updated_at, deleted_at, synced_at
      FROM whoop_profiles
      ORDER BY whoop_user_id ASC
    `).all(),
    c.env.DB.prepare(`
      SELECT whoop_user_id, height_meter, weight_kilogram, max_heart_rate,
             upstream_created_at, upstream_updated_at, deleted_at, synced_at
      FROM whoop_body_measurements
      ORDER BY whoop_user_id ASC
    `).all(),
    c.env.DB.prepare(`
      SELECT cycle_id, whoop_user_id, start_at, end_at, timezone_offset,
             score_state, strain, kilojoules, average_heart_rate,
             max_heart_rate, upstream_created_at, upstream_updated_at,
             deleted_at, synced_at
      FROM whoop_cycles
      ORDER BY start_at ASC, cycle_id ASC
    `).all(),
    c.env.DB.prepare(`
      SELECT sleep_id, cycle_id, whoop_user_id, score_state, user_calibrating,
             recovery_score, resting_heart_rate, hrv_rmssd_milliseconds,
             spo2_percentage, skin_temperature_celsius, upstream_created_at,
             upstream_updated_at, deleted_at, synced_at
      FROM whoop_recoveries
      ORDER BY upstream_updated_at ASC, sleep_id ASC
    `).all(),
    c.env.DB.prepare(`
      SELECT sleep_id, cycle_id, whoop_user_id, start_at, end_at,
             timezone_offset, nap, score_state, stage_awake_milliseconds,
             stage_in_bed_milliseconds, stage_no_data_milliseconds,
             stage_light_milliseconds, stage_slow_wave_milliseconds,
             stage_rem_milliseconds, sleep_needed_milliseconds,
             sleep_debt_milliseconds, sleep_need_recent_strain_milliseconds,
             sleep_need_recent_nap_milliseconds, sleep_cycle_count,
             disturbance_count, sleep_efficiency_percentage,
             sleep_consistency_percentage, sleep_performance_percentage,
             respiratory_rate, upstream_created_at, upstream_updated_at,
             deleted_at, synced_at
      FROM whoop_sleeps
      ORDER BY start_at ASC, sleep_id ASC
    `).all(),
    c.env.DB.prepare(`
      SELECT workout_id, whoop_user_id, start_at, end_at, timezone_offset,
             sport_id, sport_name, score_state, strain, average_heart_rate,
             max_heart_rate, kilojoules, percent_recorded, distance_meter,
             elevation_gain_meter, zone_zero_milliseconds,
             zone_one_milliseconds, zone_two_milliseconds,
             zone_three_milliseconds, zone_four_milliseconds,
             zone_five_milliseconds, upstream_created_at,
             upstream_updated_at, deleted_at, synced_at
      FROM whoop_workouts
      ORDER BY start_at ASC, workout_id ASC
    `).all(),
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
    whoop: {
      profiles: whoopProfiles.results ?? [],
      body_measurements: whoopBodyMeasurements.results ?? [],
      cycles: whoopCycles.results ?? [],
      recoveries: whoopRecoveries.results ?? [],
      sleeps: whoopSleeps.results ?? [],
      workouts: whoopWorkouts.results ?? [],
    },
  });
});

export default app;
