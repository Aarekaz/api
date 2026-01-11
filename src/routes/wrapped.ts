import { Hono } from "hono";
import type { Env } from "../types/env";
import { dateOnly, addDays } from "../utils/date";
import { buildWrapped } from "../services/wakatime";
import {
  openApiRegistry,
  genericObjectSchema,
  okResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/day",
  summary: "Get today's wrapped",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/week",
  summary: "Get this week's wrapped",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/month",
  summary: "Get this month's wrapped",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/2026",
  summary: "Get 2026 wrapped",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

// Route handlers
app.get("/day", async (c) => {
  const today = dateOnly(new Date());
  return c.json(await buildWrapped(c.env, today, today));
});

app.get("/week", async (c) => {
  const end = dateOnly(new Date());
  const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -6));
  return c.json(await buildWrapped(c.env, start, end));
});

app.get("/month", async (c) => {
  const end = dateOnly(new Date());
  const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));
  return c.json(await buildWrapped(c.env, start, end));
});

app.get("/2026", async (c) => {
  return c.json(await buildWrapped(c.env, "2026-01-01", "2026-12-31"));
});

export default app;
