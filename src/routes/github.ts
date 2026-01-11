import { Hono } from "hono";
import type { Env } from "../types/env";
import { dateOnly, addDays, daysBetween } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import { backfillSchema } from "../schemas/common";
import { refreshGitHub } from "../services/github";
import { markRefreshed } from "../services/wakatime";
import {
  openApiRegistry,
  genericObjectSchema,
  okDateRangeSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/github",
  summary: "Get GitHub data",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/github/refresh",
  summary: "Refresh GitHub data",
  security: authSecurity,
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/github/backfill",
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
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(backfillSchema, body);
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
