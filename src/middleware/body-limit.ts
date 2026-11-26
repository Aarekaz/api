import { bodyLimit } from "hono/body-limit";

/**
 * Refuses a request body over `maxBytes` with 413 `{ "error": "Payload too
 * large" }` (the dialect of the public routes that use it). A declared
 * Content-Length is checked before anything is read; a body without one is
 * cut off once it passes the limit, so a handler never holds more than that.
 * For the unauthenticated writes: the WHOOP webhook and the crowd.
 */
export const limitBody = (maxBytes: number) => bodyLimit({
  maxSize: maxBytes,
  onError: (c) => c.json({ error: "Payload too large" }, 413),
});
