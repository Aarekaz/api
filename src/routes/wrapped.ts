import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { dateOnly, addDays } from "../utils/date";
import { buildWrapped } from "../services/wakatime";
import {
  apiTags,
  openApiRegistry,
  genericObjectSchema,
  okResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
const TAG = "Wrapped";
apiTags.push({
  name: TAG,
  description: `A look back at your coding: WakaTime coding time (by day, language, project and editor) and GitHub activity, \
for today, the last 7 or 30 days, or a calendar year. Read-only: it is worked out on each request from data the server \
already syncs, so there is nothing to write.

**Public.** A year's wrapped (GET /v1/wrapped/{year}, e.g. /v1/wrapped/2026) is shown on anuragd.me. Day, week and month \
are private.

**Reading.** /v1/wrapped/day, /week (last 7 days) and /month (last 30 days) end today (UTC). /v1/wrapped/{year} takes a \
four-digit year from 2000 to next year. No uploads here.`,
});
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/day",
  tags: [TAG],
  summary: "Get today's wrapped",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/week",
  tags: [TAG],
  summary: "Get this week's wrapped",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/month",
  tags: [TAG],
  summary: "Get this month's wrapped",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/2026",
  tags: [TAG],
  summary: "Get 2026 wrapped",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/{year}",
  tags: [TAG],
  summary: "Get one calendar year's wrapped (2000 to next year)",
  security: authSecurity,
  request: { params: z.object({ year: z.string().regex(/^\d{4}$/).openapi({ example: "2025" }) }) },
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

// The website reads /2026: it stays its own route, exactly as it was.
app.get("/2026", async (c) => {
  return c.json(await buildWrapped(c.env, "2026-01-01", "2026-12-31"));
});

// Any other year. Registered after /day, /week, /month and /2026 so it never
// shadows them; anything that isn't a four-digit year is refused.
app.get("/:year", async (c) => {
  const raw = c.req.param("year");
  const year = /^\d{4}$/.test(raw) ? Number(raw) : NaN;
  if (!(year >= 2000 && year <= new Date().getUTCFullYear() + 1)) {
    return c.json({ error: "year must be a four-digit year from 2000 to next year" }, 400);
  }
  return c.json(await buildWrapped(c.env, `${year}-01-01`, `${year}-12-31`));
});

export default app;
