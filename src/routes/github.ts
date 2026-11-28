import { Hono } from "hono";
import type { Env } from "../types/env";
import { dateOnly, addDays, daysBetween } from "../utils/date";
import { readBody } from "../lib/site-http";
import { backfillSchema } from "../schemas/common";
import { githubResponseSchema } from "../schemas/responses";
import { refreshGitHub } from "../services/github";
import { markRefreshed } from "../services/wakatime";
import {
  apiTags, openApiRegistry,
  okDateRangeSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

const CODING_TAG = "Coding";
apiTags.push({
  name: CODING_TAG,
  description: `Coding activity, read from GitHub (contributions per day, commits per repo) and WakaTime (time per day and per hour). \
Nothing here is written by hand: the cron refreshes both on its own, and the refresh and backfill calls only fetch \
from those services again.

**Public.** anuragd.me reads GET /v1/github, GET /v1/wakatime and GET /v1/wakatime/hourly, so what's stored shows on the site.

**Reading.** Pass \`start\` and \`end\` (YYYY-MM-DD) as query params; without them you get the last 30 days.

**Avoid.** Don't call refresh or backfill on a schedule of your own: the cron already does it. Backfill only to fill a gap \
the owner asked about (at most 365 days for WakaTime, 370 for GitHub).`,
});


// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/github",
  tags: [CODING_TAG],
  summary: "Get GitHub data",
  security: authSecurity,
  responses: okResponses(githubResponseSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/github/refresh",
  tags: [CODING_TAG],
  summary: "Refresh GitHub data",
  security: authSecurity,
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/github/backfill",
  tags: [CODING_TAG],
  summary: "Backfill GitHub data",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(backfillSchema) },
  responses: createdResponses(okDateRangeSchema),
});

// Route handlers
app.get("/", async (c) => {
  const startParam = c.req.query("start");
  const endParam = c.req.query("end");
  const end = endParam ?? dateOnly(new Date());
  const start =
    startParam ?? dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));

  const [daily, repos] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM github_daily WHERE date BETWEEN ? AND ? ORDER BY date ASC"
    )
      .bind(start, end)
      .all(),
    c.env.DB.prepare(
      "SELECT * FROM github_repo_totals WHERE range_start = ? AND range_end = ? ORDER BY count DESC"
    )
      .bind(start, end)
      .all(),
  ]);

  return c.json({
    start,
    end,
    daily: daily.results ?? [],
    repos: repos.results ?? [],
  });
});

app.post("/refresh", async (c) => {
  try {
    const end = dateOnly(new Date());
    const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));
    await refreshGitHub(c.env, start, end);
    await markRefreshed(c.env, "github_refresh");
    return c.json({ ok: true, start, end }, 201);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "GitHub refresh failed";
    return c.json({ error: message }, 502);
  }
});

app.post("/backfill", async (c) => {
  const validation = await readBody(c, backfillSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const { start, end } = validation.data;
  if (start > end) {
    return c.json({ error: "Start date must be before end date" }, 400);
  }

  if (daysBetween(start, end) > 370) {
    return c.json({ error: "Backfill range too large" }, 400);
  }

  try {
    await refreshGitHub(c.env, start, end);
    await markRefreshed(c.env, "github_refresh");
    return c.json({ ok: true, start, end }, 201);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "GitHub backfill failed";
    return c.json({ error: message }, 502);
  }
});

export default app;
