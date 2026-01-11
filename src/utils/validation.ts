import { z } from "zod";
import type { ValidationResult } from "../types/common";
import { errorResponse } from "./response";

export function validateBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown
): ValidationResult<z.infer<T>> {
  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      response: errorResponse("Validation error", 400, result.error.flatten()),
    };
  }

  return { ok: true, data: result.data };
}

export function validateQuery<T extends z.ZodTypeAny>(
  schema: T,
  query: unknown
): ValidationResult<z.infer<T>> {
  const result = schema.safeParse(query);
  if (!result.success) {
    return {
      ok: false,
      response: errorResponse("Invalid query parameters", 400, result.error.flatten()),
    };
  }

  return { ok: true, data: result.data };
}
