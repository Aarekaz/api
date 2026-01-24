import { Context, Next } from "hono";
import { ApiError, ErrorCode, getRequestId } from "../types/errors";
import { nowIso } from "../utils/date";

/**
 * Global error handler middleware
 * - Catches all errors and returns consistent JSON responses
 * - Handles ApiError instances specially
 * - Logs errors for debugging
 * - Includes request ID in error responses
 */
export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (error) {
    const requestId = getRequestId(c);

    // Handle ApiError instances
    if (error instanceof ApiError) {
      return c.json(error.toBody(requestId), error.statusCode as 400 | 401 | 403 | 404 | 500);
    }

    // Log unexpected errors
    console.error(
      JSON.stringify({
        type: "error",
        requestId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: nowIso(),
      })
    );

    // Return generic error for unexpected exceptions
    return c.json(
      {
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: "An unexpected error occurred",
        },
        meta: {
          requestId,
          timestamp: nowIso(),
        },
      },
      500
    );
  }
}
