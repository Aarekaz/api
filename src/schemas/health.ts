import { z } from "zod";
import "./openapi";
import { DAY } from "../utils/date";

// The descriptions are the guide agents read in /openapi.json (with the Health tag's).
// The units are the ones the iPhone's HealthKit sync sends (apple/Sources/OSUI/HealthSync.swift).
// iOS Shortcuts may send any of these fields, so none is marked unused.
export const appleHealthDailySchema = z.object({
  date: z.string().regex(DAY, "Date must be YYYY-MM-DD format").openapi({ description: "The day, YYYY-MM-DD, in local time. One row per date" }),
  // Heart & Cardiovascular
  resting_heart_rate: z.number().positive().optional().openapi({ description: "Beats per minute, the day's average" }),
  heart_rate_avg: z.number().positive().optional().openapi({ description: "Beats per minute" }),
  heart_rate_min: z.number().positive().optional().openapi({ description: "Beats per minute" }),
  heart_rate_max: z.number().positive().optional().openapi({ description: "Beats per minute" }),
  hrv_avg: z.number().nonnegative().optional().openapi({ description: "Heart rate variability (SDNN), milliseconds" }),
  vo2_max: z.number().positive().optional().openapi({ description: "mL/(kg·min)" }),
  blood_oxygen_avg: z.number().min(0).max(100).optional().openapi({ description: "Percent, 0–100 (not 0–1)" }),
  blood_oxygen_min: z.number().min(0).max(100).optional().openapi({ description: "Percent, 0–100 (not 0–1)" }),
  // Body Measurements
  weight: z.number().positive().optional().openapi({ description: "Kilograms" }),
  body_fat_percentage: z.number().min(0).max(100).optional().openapi({ description: "Percent, 0–100" }),
  body_mass_index: z.number().positive().optional(),
  wrist_temperature: z.number().optional().openapi({ description: "Difference from the usual, so it can be negative" }), // Can be negative (below baseline)
  // Activity
  steps: z.number().int().nonnegative().optional().openapi({ description: "The day's total, a whole number" }),
  active_energy: z.number().nonnegative().optional().openapi({ description: "Kilocalories" }),
  resting_energy: z.number().nonnegative().optional().openapi({ description: "Kilocalories" }),
  exercise_minutes: z.number().int().nonnegative().optional().openapi({ description: "Whole minutes" }),
  stand_hours: z.number().int().min(0).max(24).optional(),
  flights_climbed: z.number().int().nonnegative().optional(),
  distance_walking_running: z.number().nonnegative().optional().openapi({ description: "Kilometres" }),
  // Sleep
  sleep_duration_minutes: z.number().int().nonnegative().optional().openapi({ description: "Whole minutes asleep" }),
  sleep_deep_minutes: z.number().int().nonnegative().optional(),
  sleep_core_minutes: z.number().int().nonnegative().optional(),
  sleep_rem_minutes: z.number().int().nonnegative().optional(),
  sleep_awake_minutes: z.number().int().nonnegative().optional(),
  respiratory_rate_avg: z.number().positive().optional().openapi({ description: "Breaths per minute" }),
  // Mindfulness
  mindful_minutes: z.number().int().nonnegative().optional(),
  // Blood Pressure
  blood_pressure_systolic: z.number().int().positive().optional().openapi({ description: "mmHg" }),
  blood_pressure_diastolic: z.number().int().positive().optional().openapi({ description: "mmHg" }),
  // Nutrition & Hydration
  water_intake_ml: z.number().int().nonnegative().optional(),
  caffeine_mg: z.number().int().nonnegative().optional(),
  // Metadata
  source: z.string().optional().openapi({ description: "What sent the day: the iPhone app sends \"healthkit\"" }),
  notes: z.string().optional(),
});
