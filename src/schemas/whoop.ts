import { z } from "zod";

const whoopDateTime = z.string().datetime({ offset: true });
const whoopUuid = z.string().uuid();
const scoreStateSchema = z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]);

export const whoopWebhookSchema = z.object({
  user_id: z.number().int().positive(),
  id: whoopUuid,
  type: z.enum([
    "workout.updated",
    "workout.deleted",
    "sleep.updated",
    "sleep.deleted",
    "recovery.updated",
    "recovery.deleted",
  ]),
  trace_id: whoopUuid,
}).strict();

export const whoopCollectionQuerySchema = z.object({
  start: whoopDateTime.optional(),
  end: whoopDateTime.optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).refine((value) => value.length % 4 !== 1, {
    message: "Invalid URL-safe base64 cursor",
  }).optional(),
}).strict();

export const whoopProfileSchema = z.object({
  user_id: z.number().int().positive(),
  email: z.string(),
  first_name: z.string(),
  last_name: z.string(),
}).passthrough();

export const whoopBodyMeasurementSchema = z.object({
  height_meter: z.number(),
  weight_kilogram: z.number(),
  max_heart_rate: z.number().int(),
}).passthrough();

export const whoopCycleSchema = z.object({
  id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  start: whoopDateTime,
  end: whoopDateTime.nullish(),
  created_at: whoopDateTime,
  updated_at: whoopDateTime,
  timezone_offset: z.string(),
  score_state: scoreStateSchema,
}).passthrough();

export const whoopRecoverySchema = z.object({
  sleep_id: whoopUuid,
  cycle_id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  created_at: whoopDateTime,
  updated_at: whoopDateTime,
  score_state: scoreStateSchema,
}).passthrough();

export const whoopSleepSchema = z.object({
  id: whoopUuid,
  cycle_id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  start: whoopDateTime,
  end: whoopDateTime,
  created_at: whoopDateTime,
  updated_at: whoopDateTime,
  timezone_offset: z.string(),
  nap: z.boolean(),
  score_state: scoreStateSchema,
  score: z.object({
    stage_summary: z.object({
      total_in_bed_time_milli: z.number().int().optional(),
      total_awake_time_milli: z.number().int().optional(),
      total_no_data_time_milli: z.number().int().optional(),
      total_light_sleep_time_milli: z.number().int().optional(),
      total_slow_wave_sleep_time_milli: z.number().int().optional(),
      total_rem_sleep_time_milli: z.number().int().optional(),
      sleep_cycle_count: z.number().int().nonnegative().optional(),
      disturbance_count: z.number().int().nonnegative().optional(),
    }).passthrough().optional(),
    sleep_needed: z.object({
      baseline_milli: z.number().int().optional(),
      need_from_sleep_debt_milli: z.number().int().optional(),
      need_from_recent_strain_milli: z.number().int().optional(),
      need_from_recent_nap_milli: z.number().int().optional(),
    }).passthrough().optional(),
  }).passthrough().nullish(),
}).passthrough();

export const whoopWorkoutSchema = z.object({
  id: whoopUuid,
  user_id: z.number().int().positive(),
  start: whoopDateTime,
  end: whoopDateTime,
  created_at: whoopDateTime,
  updated_at: whoopDateTime,
  timezone_offset: z.string(),
  sport_name: z.string(),
  score_state: scoreStateSchema,
}).passthrough();

export const whoopCollectionResponseSchema = <T extends z.ZodTypeAny>(recordSchema: T) => z.object({
  records: z.array(recordSchema),
  next_token: z.string().optional(),
}).passthrough();

export type WhoopWebhook = z.infer<typeof whoopWebhookSchema>;
export type WhoopCollectionQuery = z.infer<typeof whoopCollectionQuerySchema>;
export type WhoopProfile = z.infer<typeof whoopProfileSchema>;
export type WhoopBodyMeasurement = z.infer<typeof whoopBodyMeasurementSchema>;
export type WhoopCycle = z.infer<typeof whoopCycleSchema>;
export type WhoopRecovery = z.infer<typeof whoopRecoverySchema>;
export type WhoopSleep = z.infer<typeof whoopSleepSchema>;
export type WhoopWorkout = z.infer<typeof whoopWorkoutSchema>;
