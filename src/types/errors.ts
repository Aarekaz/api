import { Context } from "hono";
import { nowIso } from "../utils/date";

// =============================================================================
// ERROR CODES
// Machine-readable error codes for API responses
// =============================================================================

export const ErrorCode = {
  // Authentication errors (401, 403)
  MISSING_AUTH: "MISSING_AUTH",
  INVALID_TOKEN: "INVALID_TOKEN",
  TOKEN_NOT_CONFIGURED: "TOKEN_NOT_CONFIGURED",
  
  // Validation errors (400)
  INVALID_JSON: "INVALID_JSON",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_ID: "INVALID_ID",
  INVALID_DATE: "INVALID_DATE",
  INVALID_QUERY: "INVALID_QUERY",
  
  // Resource errors (404)
  NOT_FOUND: "NOT_FOUND",
  
  // Server errors (500)
  INTERNAL_ERROR: "INTERNAL_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
  EXTERNAL_API_ERROR: "EXTERNAL_API_ERROR",
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

// =============================================================================
// ERROR STRUCTURE
// Consistent error response format
// =============================================================================

export interface ApiErrorBody {
  error: {
    code: ErrorCodeType;
    message: string;
    details?: unknown;
  };
  meta: {
    requestId: string;
    timestamp: string;
  };
}

export interface ApiSuccessBody<T = unknown> {
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
  };
}

// =============================================================================
// API ERROR CLASS
// Throwable error that converts to a proper response
// =============================================================================

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCodeType,
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }

  /**
   * Convert to JSON response body
   */
  toBody(requestId: string): ApiErrorBody {
    const errorObj: ApiErrorBody["error"] = {
      code: this.code,
      message: this.message,
    };
    
    if (this.details !== undefined) {
      errorObj.details = this.details;
    }
    
    return {
      error: errorObj,
      meta: {
        requestId,
        timestamp: nowIso(),
      },
    };
  }

  // Convenience factory methods
  static badRequest(message: string, code: ErrorCodeType = ErrorCode.VALIDATION_FAILED, details?: unknown) {
    return new ApiError(code, 400, message, details);
  }

  static unauthorized(message: string = "Authentication required") {
    return new ApiError(ErrorCode.MISSING_AUTH, 401, message);
  }

  static forbidden(message: string = "Invalid credentials") {
    return new ApiError(ErrorCode.INVALID_TOKEN, 403, message);
  }

  static notFound(resource: string = "Resource") {
    return new ApiError(ErrorCode.NOT_FOUND, 404, `${resource} not found`);
  }

  static internal(message: string = "Internal server error", details?: unknown) {
    return new ApiError(ErrorCode.INTERNAL_ERROR, 500, message, details);
  }

  static database(message: string = "Database error", details?: unknown) {
    return new ApiError(ErrorCode.DATABASE_ERROR, 500, message, details);
  }

  static invalidJson() {
    return new ApiError(ErrorCode.INVALID_JSON, 400, "Request body must be valid JSON");
  }

  static invalidId() {
    return new ApiError(ErrorCode.INVALID_ID, 400, "Invalid ID format");
  }

  static invalidDate(format: string = "YYYY-MM-DD") {
    return new ApiError(ErrorCode.INVALID_DATE, 400, `Invalid date format. Expected: ${format}`);
  }
}

// =============================================================================
// REQUEST ID STORAGE
// Store request IDs using WeakMap keyed by request object
// =============================================================================

const requestIdMap = new WeakMap<Request, string>();

/** Get request ID (or generate one if not set) */
export function getRequestId(c: Context): string {
  const existing = requestIdMap.get(c.req.raw);
  if (existing) {
    return existing;
  }
  const newId = crypto.randomUUID();
  requestIdMap.set(c.req.raw, newId);
  return newId;
}

/** Set request ID for context */
export function setRequestId(c: Context, requestId: string): void {
  requestIdMap.set(c.req.raw, requestId);
}

