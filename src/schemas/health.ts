import { z } from "zod";
import { dateString } from "./common";

export const appleHealthDailySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
  // Heart & Cardiovascular
  resting_heart_rate: z.number().positive().optional(),
  heart_rate_avg: z.number().positive().optional(),
  heart_rate_min: z.number().positive().optional(),
  heart_rate_max: z.number().positive().optional(),
  hrv_avg: z.number().nonnegative().optional(),
  vo2_max: z.number().positive().optional(),
  blood_oxygen_avg: z.number().min(0).max(100).optional(),
  blood_oxygen_min: z.number().min(0).max(100).optional(),
  // Body Measurements
  weight: z.number().positive().optional(),
  body_fat_percentage: z.number().min(0).max(100).optional(),
  body_mass_index: z.number().positive().optional(),
  wrist_temperature: z.number().optional(), // Can be negative (below baseline)
  // Activity
  steps: z.number().int().nonnegative().optional(),
  active_energy: z.number().nonnegative().optional(),
  resting_energy: z.number().nonnegative().optional(),
  exercise_minutes: z.number().int().nonnegative().optional(),
  stand_hours: z.number().int().min(0).max(24).optional(),
  flights_climbed: z.number().int().nonnegative().optional(),
  distance_walking_running: z.number().nonnegative().optional(),
  // Sleep
  sleep_duration_minutes: z.number().int().nonnegative().optional(),
  sleep_deep_minutes: z.number().int().nonnegative().optional(),
  sleep_core_minutes: z.number().int().nonnegative().optional(),
  sleep_rem_minutes: z.number().int().nonnegative().optional(),
  sleep_awake_minutes: z.number().int().nonnegative().optional(),
  respiratory_rate_avg: z.number().positive().optional(),
  // Mindfulness
  mindful_minutes: z.number().int().nonnegative().optional(),
  // Blood Pressure
  blood_pressure_systolic: z.number().int().positive().optional(),
  blood_pressure_diastolic: z.number().int().positive().optional(),
  // Nutrition & Hydration
  water_intake_ml: z.number().int().nonnegative().optional(),
  caffeine_mg: z.number().int().nonnegative().optional(),
  // Metadata
  source: z.string().optional(),
  notes: z.string().optional(),
});

// Infer type from schema for type safety
export type AppleHealthDaily = z.infer<typeof appleHealthDailySchema>;

export const appleHealthHeartRateSchema = z.object({
  recorded_at: dateString,
  heart_rate: z.number().positive(),
  context: z.string().optional(),
  source: z.string().optional(),
});

export type AppleHealthHeartRate = z.infer<typeof appleHealthHeartRateSchema>;

export const appleHealthHeartRateBatchSchema = z.object({
  samples: z.array(appleHealthHeartRateSchema).min(1).max(1000),
});

export type AppleHealthHeartRateBatch = z.infer<typeof appleHealthHeartRateBatchSchema>;

export const appleHealthSleepSessionSchema = z.object({
  start_at: dateString,
  end_at: dateString,
  duration_minutes: z.number().int().nonnegative().optional(),
  deep_minutes: z.number().int().nonnegative().optional(),
  core_minutes: z.number().int().nonnegative().optional(),
  rem_minutes: z.number().int().nonnegative().optional(),
  awake_minutes: z.number().int().nonnegative().optional(),
  sleep_quality_score: z.number().min(0).max(100).optional(),
  respiratory_rate_avg: z.number().positive().optional(),
  heart_rate_avg: z.number().positive().optional(),
  hrv_avg: z.number().nonnegative().optional(),
});

export type AppleHealthSleepSession = z.infer<typeof appleHealthSleepSessionSchema>;

export const appleHealthWorkoutSchema = z.object({
  workout_type: z.string().min(1),
  start_at: dateString,
  end_at: dateString,
  duration_minutes: z.number().int().nonnegative().optional(),
  active_energy: z.number().nonnegative().optional(),
  heart_rate_avg: z.number().positive().optional(),
  heart_rate_max: z.number().positive().optional(),
  distance: z.number().nonnegative().optional(),
  elevation_gain: z.number().nonnegative().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
});

export type AppleHealthWorkout = z.infer<typeof appleHealthWorkoutSchema>;

export const healthQuerySchema = z.object({
  start: dateString.optional(),
  end: dateString.optional(),
});

export const healthHeartRateQuerySchema = z.object({
  start: dateString.optional(),
  end: dateString.optional(),
  limit: z.string().optional(),
});

export const healthWorkoutsQuerySchema = z.object({
  start: dateString.optional(),
  end: dateString.optional(),
  type: z.string().optional(),
  limit: z.string().optional(),
});
