import { z } from "zod";
import { dateString } from "./common";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format");

export const logEntrySchema = z.object({
  type: z.string().min(1),
  occurred_at: dateString.optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metrics: z.record(z.unknown()).optional(),
  refs: z.record(z.unknown()).optional(),
});

export const logDayInputSchema = z.object({
  log_date: dateOnlySchema,
  title: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  entries: z.array(logEntrySchema).optional(),
});

export const logDaySchema = logDayInputSchema.extend({
  id: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const logsQuerySchema = z.object({
  start: dateOnlySchema.optional(),
  end: dateOnlySchema.optional(),
  limit: z.string().optional(),
});
