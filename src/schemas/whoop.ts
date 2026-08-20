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
  cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

export const whoopProfileSchema = z.object({
  user_id: z.number().int().positive(),
  created_at: whoopDateTime.optional(),
  updated_at: whoopDateTime.optional(),
}).passthrough();

export const whoopBodyMeasurementSchema = z.object({
  user_id: z.number().int().positive(),
  created_at: whoopDateTime.optional(),
  updated_at: whoopDateTime.optional(),
}).passthrough();

export const whoopCycleSchema = z.object({
  id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  start: whoopDateTime,
  end: whoopDateTime,
  created_at: whoopDateTime,
  updated_at: whoopDateTime,
  score_state: scoreStateSchema.optional(),
}).passthrough();

export const whoopRecoverySchema = z.object({
  sleep_id: whoopUuid,
  cycle_id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  created_at: whoopDateTime,
  updated_at: whoopDateTime,
  score_state: scoreStateSchema.optional(),
}).passthrough();

export const whoopSleepSchema = z.object({
  id: whoopUuid,
  cycle_id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  start: whoopDateTime.optional(),
  end: whoopDateTime.optional(),
  created_at: whoopDateTime,
  updated_at: whoopDateTime,
  score_state: scoreStateSchema.optional(),
}).passthrough();

export const whoopWorkoutSchema = z.object({
  id: whoopUuid,
  user_id: z.number().int().positive(),
  start: whoopDateTime.optional(),
  end: whoopDateTime.optional(),
  created_at: whoopDateTime,
  updated_at: whoopDateTime,
  score_state: scoreStateSchema.optional(),
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
