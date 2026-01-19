import { Context, Next } from "hono";
import { getRequestId, setRequestId } from "../types/errors";
import { nowIso } from "../utils/date";

/**
 * Request logger middleware
 * - Generates unique request ID for each request
 * - Logs request details (method, path, timing)
 * - Adds request ID to response headers
 */
export async function requestLogger(c: Context, next: Next) {
  const requestId = crypto.randomUUID();
  setRequestId(c, requestId);

  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  // Add request ID to response headers
  c.header("X-Request-ID", requestId);

  try {
    await next();
  } finally {
    const duration = Date.now() - start;
    const status = c.res.status;

    // Log request summary (visible in Cloudflare Workers logs)
    console.log(
      JSON.stringify({
        type: "request",
        requestId,
        method,
        path,
        status,
        duration,
        timestamp: nowIso(),
      })
    );
  }
}
