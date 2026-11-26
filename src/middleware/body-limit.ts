import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * Refuses a request body over `maxBytes` with 413 "Payload too large", by
 * default as `{ "error": "Payload too large" }` (the crowd's dialect); pass
 * `tooLarge` for another (the WHOOP webhook answers in lib/http.ts's shape).
 * A declared Content-Length is checked before anything is read; a body without
 * one is cut off once it passes the limit, so a handler never holds more than
 * that. For the unauthenticated writes: the WHOOP webhook and the crowd.
 */
export const limitBody = (
  maxBytes: number,
  tooLarge: (c: Context) => Response = (c) => c.json({ error: "Payload too large" }, 413),
) => bodyLimit({ maxSize: maxBytes, onError: tooLarge });
