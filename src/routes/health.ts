import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import {
  openApiRegistry,
  healthResponseSchema,
  okResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registration
openApiRegistry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  security: authSecurity,
  responses: okResponses(healthResponseSchema),
});

// Route handler
app.get("/", (c) => {
  return c.json({
    status: "ok",
    version: c.env.API_VERSION ?? "unknown",
    timestamp: nowIso(),
  });
});

export default app;
