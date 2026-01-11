import { z } from "zod";

export const dateString = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Invalid date",
});

export const backfillSchema = z.object({
  start: dateString,
  end: dateString,
});

export const rangeQuerySchema = z.object({
  start: dateString.optional(),
  end: dateString.optional(),
});

// Location schemas
export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().optional(),
  accuracy: z.number().nonnegative().optional(),
  speed: z.number().nonnegative().optional(),
  heading: z.number().min(0).max(360).optional(),
  recorded_at: dateString,
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postal_code: z.string().optional(),
  label: z.string().optional(),
  notes: z.string().optional(),
  source: z.string().optional(),
});

export const locationQuerySchema = z.object({
  start: dateString.optional(),
  end: dateString.optional(),
  label: z.string().optional(),
  limit: z.string().optional(),
});
