import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { dateOnly, addDays, daysBetween } from "../utils/date";
import { parseJson } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeWakaTimeHourly } from "../utils/normalizers";
import { backfillSchema } from "../schemas/common";
import {
  refreshWakaTime,
  refreshWakaTimeHourly,
  markRefreshed,
} from "../services/wakatime";
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
  path: "/v1/wakatime",
  summary: "Get WakaTime data",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wakatime/hourly",
  summary: "Get WakaTime hourly data",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/wakatime/refresh",
  summary: "Refresh WakaTime data",
  security: authSecurity,
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/wakatime/hourly/refresh",
  summary: "Refresh WakaTime hourly data",
  security: authSecurity,
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/wakatime/backfill",
  summary: "Backfill WakaTime data",
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

  const [days, languages, projects, editors] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM wakatime_days WHERE date BETWEEN ? AND ? ORDER BY date ASC"
    )
      .bind(start, end)
      .all(),
    c.env.DB.prepare(
      "SELECT * FROM wakatime_languages WHERE date BETWEEN ? AND ? ORDER BY date ASC, total_seconds DESC"
    )
      .bind(start, end)
      .all(),
    c.env.DB.prepare(
      "SELECT * FROM wakatime_projects WHERE date BETWEEN ? AND ? ORDER BY date ASC, total_seconds DESC"
    )
      .bind(start, end)
      .all(),
    c.env.DB.prepare(
      "SELECT * FROM wakatime_editors WHERE date BETWEEN ? AND ? ORDER BY date ASC, total_seconds DESC"
    )
      .bind(start, end)
      .all(),
  ]);

  return c.json({
    start,
    end,
    days: days.results ?? [],
    languages: languages.results ?? [],
    projects: projects.results ?? [],
    editors: editors.results ?? [],
  });
});

app.get("/hourly", async (c) => {
  const startParam = c.req.query("start");
  const endParam = c.req.query("end");
  const end = endParam ?? dateOnly(new Date());
  const start =
    startParam ?? dateOnly(addDays(new Date(`${end}T00:00:00Z`), -6));

  const rows = await c.env.DB.prepare(
    "SELECT * FROM wakatime_hourly WHERE date BETWEEN ? AND ? ORDER BY date ASC, hour ASC"
  )
    .bind(start, end)
    .all();

  const results = (rows.results ?? []).map((row) =>
    normalizeWakaTimeHourly(row as JsonRecord)
  );

  return c.json({ start, end, hours: results });
});

app.post("/refresh", async (c) => {
  try {
    const end = dateOnly(new Date());
    const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -6));
    await refreshWakaTime(c.env, start, end);
    await markRefreshed(c.env, "wakatime_daily");
    return c.json({ ok: true, start, end }, 201);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "WakaTime refresh failed";
    return c.json({ error: message }, 502);
  }
});

app.post("/hourly/refresh", async (c) => {
  try {
    const end = dateOnly(new Date());
    const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -6));
    await refreshWakaTimeHourly(c.env, start, end);
    await markRefreshed(c.env, "wakatime_hourly");
    return c.json({ ok: true, start, end }, 201);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "WakaTime hourly refresh failed";
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
  const days = daysBetween(start, end);
  if (days > 365) {
    return c.json({ error: "Date range too large (max 365 days)" }, 400);
  }

  try {
    await refreshWakaTime(c.env, start, end);
    await refreshWakaTimeHourly(c.env, start, end);
    return c.json({ ok: true, start, end }, 201);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "WakaTime backfill failed";
    return c.json({ error: message }, 502);
  }
});

export default app;
