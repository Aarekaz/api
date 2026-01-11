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
