import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso, dateOnly, addDays } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import { parseId } from "../utils/query";
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
  okUpdatedSchema,
  okDeletedSchema,
  healthDailyRangeResponseSchema,
  healthDailyUpdateResponseSchema,
  healthDailyDeleteResponseSchema,
  healthHeartRateRangeResponseSchema,
  healthHeartRateBatchResponseSchema,
  healthSleepRangeResponseSchema,
  healthWorkoutsRangeResponseSchema,
  healthSummaryResponseSchema,
  dateSchema,
  errorSchema,
  openApiResponse,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

const workoutPatchSchema = appleHealthWorkoutSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

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


// /v1/health is the iPhone's daily Apple Health totals (GET a range, POST a day).
// The per-sample routes (heart rate, sleep, workouts, summary, by date) were the old
// dashboard's and had no rows and no callers; unmounted 2026-11-25, tables kept.

export default app;
