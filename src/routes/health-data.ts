import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso, dateOnly, addDays } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import {
  appleHealthDailySchema,
  appleHealthHeartRateSchema,
  appleHealthHeartRateBatchSchema,
  appleHealthSleepSessionSchema,
  appleHealthWorkoutSchema,
} from "../schemas/health";
import {
  openApiRegistry,
  genericObjectSchema,
  healthDailyRangeResponseSchema,
  healthDailyUpdateResponseSchema,
  healthDailyDeleteResponseSchema,
  healthHeartRateRangeResponseSchema,
  healthHeartRateBatchResponseSchema,
  healthSleepRangeResponseSchema,
  healthWorkoutsRangeResponseSchema,
  healthSummaryResponseSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health",
  summary: "Get daily health data",
  security: authSecurity,
  responses: okResponses(healthDailyRangeResponseSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/health",
  summary: "Create/update daily health data",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(appleHealthDailySchema) },
  responses: createdResponses(healthDailyUpdateResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health/heart-rate",
  summary: "Get heart rate samples",
  security: authSecurity,
  responses: okResponses(healthHeartRateRangeResponseSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/health/heart-rate",
  summary: "Create heart rate samples",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(appleHealthHeartRateBatchSchema) },
  responses: createdResponses(healthHeartRateBatchResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health/sleep",
  summary: "Get sleep sessions",
  security: authSecurity,
  responses: okResponses(healthSleepRangeResponseSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/health/sleep",
  summary: "Create sleep session",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(appleHealthSleepSessionSchema) },
  responses: createdResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health/workouts",
  summary: "Get workouts",
  security: authSecurity,
  responses: okResponses(healthWorkoutsRangeResponseSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/health/workouts",
  summary: "Create workout",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(appleHealthWorkoutSchema) },
  responses: createdResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/health/summary",
  summary: "Get health summary",
  security: authSecurity,
  responses: okResponses(healthSummaryResponseSchema),
});

// Route handlers
app.get("/", async (c) => {
  const startParam = c.req.query("start");
  const endParam = c.req.query("end");
  const end = endParam ?? dateOnly(new Date());
  const start =
    startParam ?? dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));

  const rows = await c.env.DB.prepare(
    "SELECT * FROM apple_health_daily WHERE date BETWEEN ? AND ? ORDER BY date DESC"
  )
    .bind(start, end)
    .all();

  return c.json({
    start,
    end,
    days: rows.results ?? [],
  });
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(appleHealthDailySchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO apple_health_daily (
      date, resting_heart_rate, heart_rate_avg, heart_rate_min, heart_rate_max,
      hrv_avg, vo2_max, blood_oxygen_avg, blood_oxygen_min,
      weight, body_fat_percentage, body_mass_index, wrist_temperature,
      steps, active_energy, resting_energy, exercise_minutes, stand_hours,
      flights_climbed, distance_walking_running,
      sleep_duration_minutes, sleep_deep_minutes, sleep_core_minutes,
      sleep_rem_minutes, sleep_awake_minutes, respiratory_rate_avg,
      mindful_minutes, blood_pressure_systolic, blood_pressure_diastolic,
      water_intake_ml, caffeine_mg, source, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      resting_heart_rate = COALESCE(excluded.resting_heart_rate, apple_health_daily.resting_heart_rate),
      heart_rate_avg = COALESCE(excluded.heart_rate_avg, apple_health_daily.heart_rate_avg),
      heart_rate_min = COALESCE(excluded.heart_rate_min, apple_health_daily.heart_rate_min),
      heart_rate_max = COALESCE(excluded.heart_rate_max, apple_health_daily.heart_rate_max),
      hrv_avg = COALESCE(excluded.hrv_avg, apple_health_daily.hrv_avg),
      vo2_max = COALESCE(excluded.vo2_max, apple_health_daily.vo2_max),
      blood_oxygen_avg = COALESCE(excluded.blood_oxygen_avg, apple_health_daily.blood_oxygen_avg),
      blood_oxygen_min = COALESCE(excluded.blood_oxygen_min, apple_health_daily.blood_oxygen_min),
      weight = COALESCE(excluded.weight, apple_health_daily.weight),
      body_fat_percentage = COALESCE(excluded.body_fat_percentage, apple_health_daily.body_fat_percentage),
      body_mass_index = COALESCE(excluded.body_mass_index, apple_health_daily.body_mass_index),
      wrist_temperature = COALESCE(excluded.wrist_temperature, apple_health_daily.wrist_temperature),
      steps = COALESCE(excluded.steps, apple_health_daily.steps),
      active_energy = COALESCE(excluded.active_energy, apple_health_daily.active_energy),
      resting_energy = COALESCE(excluded.resting_energy, apple_health_daily.resting_energy),
      exercise_minutes = COALESCE(excluded.exercise_minutes, apple_health_daily.exercise_minutes),
      stand_hours = COALESCE(excluded.stand_hours, apple_health_daily.stand_hours),
      flights_climbed = COALESCE(excluded.flights_climbed, apple_health_daily.flights_climbed),
      distance_walking_running = COALESCE(excluded.distance_walking_running, apple_health_daily.distance_walking_running),
      sleep_duration_minutes = COALESCE(excluded.sleep_duration_minutes, apple_health_daily.sleep_duration_minutes),
      sleep_deep_minutes = COALESCE(excluded.sleep_deep_minutes, apple_health_daily.sleep_deep_minutes),
      sleep_core_minutes = COALESCE(excluded.sleep_core_minutes, apple_health_daily.sleep_core_minutes),
      sleep_rem_minutes = COALESCE(excluded.sleep_rem_minutes, apple_health_daily.sleep_rem_minutes),
      sleep_awake_minutes = COALESCE(excluded.sleep_awake_minutes, apple_health_daily.sleep_awake_minutes),
      respiratory_rate_avg = COALESCE(excluded.respiratory_rate_avg, apple_health_daily.respiratory_rate_avg),
      mindful_minutes = COALESCE(excluded.mindful_minutes, apple_health_daily.mindful_minutes),
      blood_pressure_systolic = COALESCE(excluded.blood_pressure_systolic, apple_health_daily.blood_pressure_systolic),
      blood_pressure_diastolic = COALESCE(excluded.blood_pressure_diastolic, apple_health_daily.blood_pressure_diastolic),
      water_intake_ml = COALESCE(excluded.water_intake_ml, apple_health_daily.water_intake_ml),
      caffeine_mg = COALESCE(excluded.caffeine_mg, apple_health_daily.caffeine_mg),
      source = COALESCE(excluded.source, apple_health_daily.source),
      notes = COALESCE(excluded.notes, apple_health_daily.notes),
      updated_at = excluded.updated_at`
  )
    .bind(
      validation.data.date,
      validation.data.resting_heart_rate ?? null,
      validation.data.heart_rate_avg ?? null,
      validation.data.heart_rate_min ?? null,
      validation.data.heart_rate_max ?? null,
      validation.data.hrv_avg ?? null,
      validation.data.vo2_max ?? null,
      validation.data.blood_oxygen_avg ?? null,
      validation.data.blood_oxygen_min ?? null,
      validation.data.weight ?? null,
      validation.data.body_fat_percentage ?? null,
      validation.data.body_mass_index ?? null,
      validation.data.wrist_temperature ?? null,
      validation.data.steps ?? null,
      validation.data.active_energy ?? null,
      validation.data.resting_energy ?? null,
      validation.data.exercise_minutes ?? null,
      validation.data.stand_hours ?? null,
      validation.data.flights_climbed ?? null,
      validation.data.distance_walking_running ?? null,
      validation.data.sleep_duration_minutes ?? null,
      validation.data.sleep_deep_minutes ?? null,
      validation.data.sleep_core_minutes ?? null,
      validation.data.sleep_rem_minutes ?? null,
      validation.data.sleep_awake_minutes ?? null,
      validation.data.respiratory_rate_avg ?? null,
      validation.data.mindful_minutes ?? null,
      validation.data.blood_pressure_systolic ?? null,
      validation.data.blood_pressure_diastolic ?? null,
      validation.data.water_intake_ml ?? null,
      validation.data.caffeine_mg ?? null,
      validation.data.source ?? null,
      validation.data.notes ?? null,
      now,
      now
    )
    .run();

  return c.json({ ok: true, date: validation.data.date, updated_at: now }, 201);
});

// Heart rate samples
app.get("/heart-rate", async (c) => {
  const startParam = c.req.query("start");
  const endParam = c.req.query("end");
  const limitParam = c.req.query("limit");
  const end = endParam ?? nowIso();
  const start =
    startParam ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const limit = Math.min(Number(limitParam) || 1000, 10000);

  const rows = await c.env.DB.prepare(
    "SELECT * FROM apple_health_heart_rate WHERE recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC LIMIT ?"
  )
    .bind(start, end, limit)
    .all();

  return c.json({
    start,
    end,
    count: rows.results?.length ?? 0,
    samples: rows.results ?? [],
  });
});

app.post("/heart-rate", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Check if it's a batch request
  const batchValidation = appleHealthHeartRateBatchSchema.safeParse(body);
  if (batchValidation.success) {
    const samples = batchValidation.data.samples;
    const now = nowIso();
    let inserted = 0;

    for (const sample of samples) {
      await c.env.DB.prepare(
        `INSERT INTO apple_health_heart_rate (recorded_at, heart_rate, context, source, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          sample.recorded_at,
          sample.heart_rate,
          sample.context ?? null,
          sample.source ?? null,
          now
        )
        .run();
      inserted++;
    }

    return c.json({ ok: true, inserted, created_at: now }, 201);
  }

  // Single sample
  const validation = validateBody(appleHealthHeartRateSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO apple_health_heart_rate (recorded_at, heart_rate, context, source, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.recorded_at,
      validation.data.heart_rate,
      validation.data.context ?? null,
      validation.data.source ?? null,
      now
    )
    .run();

  return c.json({ ok: true, created_at: now }, 201);
});

// Sleep sessions
app.get("/sleep", async (c) => {
  const startParam = c.req.query("start");
  const endParam = c.req.query("end");
  const end = endParam ?? nowIso();
  const start =
    startParam ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const rows = await c.env.DB.prepare(
    "SELECT * FROM apple_health_sleep_sessions WHERE start_at BETWEEN ? AND ? ORDER BY start_at DESC"
  )
    .bind(start, end)
    .all();

  return c.json({
    start,
    end,
    count: rows.results?.length ?? 0,
    sessions: rows.results ?? [],
  });
});

app.post("/sleep", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(appleHealthSleepSessionSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO apple_health_sleep_sessions (
      start_at, end_at, duration_minutes, deep_minutes, core_minutes,
      rem_minutes, awake_minutes, sleep_quality_score, respiratory_rate_avg,
      heart_rate_avg, hrv_avg, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.start_at,
      validation.data.end_at,
      validation.data.duration_minutes ?? null,
      validation.data.deep_minutes ?? null,
      validation.data.core_minutes ?? null,
      validation.data.rem_minutes ?? null,
      validation.data.awake_minutes ?? null,
      validation.data.sleep_quality_score ?? null,
      validation.data.respiratory_rate_avg ?? null,
      validation.data.heart_rate_avg ?? null,
      validation.data.hrv_avg ?? null,
      now
    )
    .run();

  return c.json({ ok: true, created_at: now }, 201);
});

// Workouts
app.get("/workouts", async (c) => {
  const startParam = c.req.query("start");
  const endParam = c.req.query("end");
  const typeParam = c.req.query("type");
  const limitParam = c.req.query("limit");
  const end = endParam ?? nowIso();
  const start =
    startParam ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const limit = Math.min(Number(limitParam) || 100, 1000);

  let query = "SELECT * FROM apple_health_workouts WHERE start_at BETWEEN ? AND ?";
  const bindings: (string | number)[] = [start, end];

  if (typeParam) {
    query += " AND workout_type = ?";
    bindings.push(typeParam);
  }

  query += " ORDER BY start_at DESC LIMIT ?";
  bindings.push(limit);

  const rows = await c.env.DB.prepare(query).bind(...bindings).all();

  return c.json({
    start,
    end,
    count: rows.results?.length ?? 0,
    workouts: rows.results ?? [],
  });
});

app.post("/workouts", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(appleHealthWorkoutSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO apple_health_workouts (
      workout_type, start_at, end_at, duration_minutes, active_energy,
      heart_rate_avg, heart_rate_max, distance, elevation_gain, source, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.workout_type,
      validation.data.start_at,
      validation.data.end_at,
      validation.data.duration_minutes ?? null,
      validation.data.active_energy ?? null,
      validation.data.heart_rate_avg ?? null,
      validation.data.heart_rate_max ?? null,
      validation.data.distance ?? null,
      validation.data.elevation_gain ?? null,
      validation.data.source ?? null,
      validation.data.notes ?? null,
      now
    )
    .run();

  return c.json({ ok: true, created_at: now }, 201);
});

// Summary
app.get("/summary", async (c) => {
  const [latestDaily, recentSleepData, recentWorkoutsData] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM apple_health_daily ORDER BY date DESC LIMIT 7"
    ).all(),
    c.env.DB.prepare(
      "SELECT * FROM apple_health_sleep_sessions ORDER BY start_at DESC LIMIT 7"
    ).all(),
    c.env.DB.prepare(
      "SELECT * FROM apple_health_workouts ORDER BY start_at DESC LIMIT 10"
    ).all(),
  ]);

  const dailyData = latestDaily.results ?? [];
  const latest = dailyData[0] as JsonRecord | undefined;
  const recentSleep = recentSleepData;
  const recentWorkouts = recentWorkoutsData;

  const avgSteps =
    dailyData.results && dailyData.results.length > 0
      ? Math.round(
          dailyData.results
            .filter((d) => (d as JsonRecord).steps != null)
            .reduce((sum, d) => sum + Number((d as JsonRecord).steps ?? 0), 0) /
            dailyData.results.filter((d) => (d as JsonRecord).steps != null).length || 1
        )
      : null;

  const avgRestingHR =
    dailyData.results && dailyData.results.length > 0
      ? Math.round(
          dailyData.results
            .filter((d) => (d as JsonRecord).resting_heart_rate != null)
            .reduce((sum, d) => sum + Number((d as JsonRecord).resting_heart_rate ?? 0), 0) /
            dailyData.results.filter((d) => (d as JsonRecord).resting_heart_rate != null).length || 1
        )
      : null;

  return c.json({
    latest: latest.results?.[0] ?? null,
    averages_7_days: {
      steps: avgSteps,
      resting_heart_rate: avgRestingHR,
    },
    recent_days: dailyData.results ?? [],
    recent_sleep: recentSleep.results ?? [],
    recent_workouts: recentWorkouts.results ?? [],
  });
});

// Get specific day (must be after specific routes like /heart-rate, /sleep, etc.)
app.get("/:date", async (c) => {
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "Invalid date format" }, 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT * FROM apple_health_daily WHERE date = ?"
  )
    .bind(date)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "No data found for this date" }, 404);
  }

  return c.json(row.results[0] as JsonRecord);
});

// Delete specific day (must be after specific routes)
app.delete("/:date", async (c) => {
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "Invalid date format" }, 400);
  }

  await c.env.DB.prepare("DELETE FROM apple_health_daily WHERE date = ?")
    .bind(date)
    .run();
  return c.json({ ok: true, deleted: date });
});

export default app;
