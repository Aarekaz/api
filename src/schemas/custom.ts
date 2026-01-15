import { z } from "zod";
import { dateString } from "./common";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format");

export const customExerciseInputSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().optional(),
  muscles: z.array(z.string()).optional(),
  equipment: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const customExerciseSchema = customExerciseInputSchema.extend({
  id: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const targetSetSchema = z.object({
  set_number: z.number().int().min(1),
  reps: z.number().int().min(0).optional(),
  weight: z.number().min(0).optional(),
  weight_unit: z.enum(["kg", "lb"]).optional(),
  rest_seconds: z.number().int().min(0).optional(),
  notes: z.string().optional(),
});

export const templateExerciseSchema = z.object({
  exercise_id: z.number().int().positive(),
  order: z.number().int().min(1),
  target_sets: z.array(targetSetSchema).optional(),
  notes: z.string().optional(),
});

export const customWorkoutTemplateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  exercises: z.array(templateExerciseSchema).optional(),
});

export const customWorkoutTemplateSchema = customWorkoutTemplateInputSchema.extend({
  id: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const customWorkoutScheduleInputSchema = z.object({
  template_id: z.number().int().positive(),
  timezone: z.string().min(1),
  rrule: z.string().optional(),
  days_of_week: z
    .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
    .optional(),
  start_date: dateOnlySchema.optional(),
  end_date: dateOnlySchema.optional(),
  exceptions: z.array(dateOnlySchema).optional(),
});

export const customWorkoutScheduleSchema = customWorkoutScheduleInputSchema.extend({
  id: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const workoutSessionStatusSchema = z.enum([
  "planned",
  "in_progress",
  "completed",
  "skipped",
]);

export const customWorkoutSessionInputSchema = z.object({
  template_id: z.number().int().positive().optional(),
  title: z.string().optional(),
  status: workoutSessionStatusSchema,
  started_at: dateString.optional(),
  ended_at: dateString.optional(),
  notes: z.string().optional(),
});

export const customWorkoutSessionSchema = customWorkoutSessionInputSchema.extend({
  id: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const workoutSetInputSchema = z.object({
  exercise_id: z.number().int().positive(),
  set_number: z.number().int().min(1),
  reps: z.number().int().min(0).optional(),
  weight: z.number().min(0).optional(),
  weight_unit: z.enum(["kg", "lb"]).optional(),
  rpe: z.number().min(0).max(10).optional(),
  done: z.boolean().optional(),
  notes: z.string().optional(),
  performed_at: dateString.optional(),
});

export const workoutSetBulkInputSchema = z.object({
  sets: z.array(workoutSetInputSchema).min(1),
});

export const workoutSetPatchSchema = workoutSetInputSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const workoutSetSchema = workoutSetInputSchema.extend({
  id: z.number().int(),
  session_id: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const customExercisesQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

export const customWorkoutTemplatesQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

export const customWorkoutSchedulesQuerySchema = z.object({
  template_id: z.string().optional(),
  start: dateOnlySchema.optional(),
  end: dateOnlySchema.optional(),
});

export const customWorkoutSessionsQuerySchema = z.object({
  start: dateString.optional(),
  end: dateString.optional(),
  status: z.string().optional(),
  template_id: z.string().optional(),
});

export const customWorkoutSetsQuerySchema = z.object({
  exercise_id: z.string(),
  limit: z.string().optional(),
});
