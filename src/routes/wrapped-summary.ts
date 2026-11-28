import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { appErrors, fail } from "../lib/http";
import { isDay, shiftDay } from "../utils/date";
import { derived } from "../services/derived-cache";
import { wrappedSummary, zoneClock } from "../services/wrapped-summary";
import { cachedTrips } from "./visits";
import { authSecurity, genericObjectSchema, openApiRegistry, structuredOkResponses } from "../schemas/openapi";

// GET /v1/wrapped/summary: one period of the app's Wrapped in one request
// (services/wrapped-summary.ts). App-only, so errors are lib/http.ts's shape.
// Mounted before /v1/wrapped so /:year never sees "summary".
const app = appErrors(new Hono<{ Bindings: Env }>(), "Wrapped summary request");

/** Bump when the summary's shape or rules change, so kept past periods are built again. */
const BUILD = 1;
const MAX_DAYS = 3660;

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/summary",
  tags: ["Wrapped"],
  summary: "One period of Wrapped, summed on the server",
  description: "Everything the app's Wrapped shows for one period, in one request: coding (WakaTime), GitHub, training, "
    + "body (WHOOP and Apple Health), places, music, the shelf diary, reading, writing and the journal, cut to the period's "
    + "local days in `tz` and summed. `from` and `to` are local days, both included. A period that ended before today in "
    + "`tz` is kept (derived_cache) and built again the next UTC day; the current one is worked out on each request. "
    + "Strong ETag: send If-None-Match for a 304. Private: never shown on anuragd.me.",
  security: authSecurity,
  request: {
    query: z.object({
      from: z.string().openapi({ example: "2026-01-01", description: "First local day" }),
      to: z.string().openapi({ example: "2026-12-31", description: "Last local day, included" }),
      tz: z.string().optional().openapi({ example: "America/New_York", description: "IANA time zone; WAKATIME_TIMEZONE, else UTC, when left out" }),
    }),
  },
  responses: structuredOkResponses(genericObjectSchema),
});

const validZone = (tz: string) => {
  try { zoneClock(tz); return true; } catch { return false; }
};

app.get("/", async (c) => {
  const from = c.req.query("from"), to = c.req.query("to");
  const tz = c.req.query("tz") || c.env.WAKATIME_TIMEZONE || "UTC";
  if (!isDay(from) || !isDay(to)) return fail(c, 400, "from and to must look like 2026-11-24");
  if (to < from) return fail(c, 400, "to must not be before from");
  if (shiftDay(from, MAX_DAYS) <= to) return fail(c, 400, `A period is at most ${MAX_DAYS} days`);
  if (!validZone(tz)) return fail(c, 400, "tz must be an IANA time zone, like America/New_York");

  const period = { from, to, tz };
  const build = () => wrappedSummary(c.env, period, (offset) => cachedTrips(c.env, offset));
  const today = zoneClock(tz)(Date.now()).day;
  if (to >= today) {
    return c.body(JSON.stringify(await build()), 200, { "Content-Type": "application/json", "X-Derived-Cache": "bypass" });
  }
  // A past period: kept until the next UTC day (late syncs and edits show up then).
  const found = await derived(c.env, {
    name: "wrapped-summary", params: `from=${from}&to=${to}&tz=${tz}`, data: "daily",
    shape: `${BUILD}|${c.env.API_VERSION ?? ""}`, build,
  });
  return c.body(found.body, 200, { "Content-Type": "application/json", "X-Derived-Cache": found.source });
});

export default app;
