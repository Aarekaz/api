import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { dateOnly, addDays } from "../utils/date";
import { fetchLanyardStatus, saveStatusSnapshot } from "../services/lanyard";
import { refreshWakaTime, refreshWakaTimeHourly, markRefreshed } from "../services/wakatime";
import { refreshGitHub } from "../services/github";
import {
  openApiRegistry,
  genericObjectSchema,
  okResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registration
openApiRegistry.registerPath({
  method: "post",
  path: "/v1/refresh",
  summary: "Refresh all data sources",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

// Route handler
app.post("/", async (c) => {
  const results: JsonRecord = {};
  const today = dateOnly(new Date());
  const lastWeek = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -6));
  const lastMonth = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -29));

  // Refresh status
  if (c.env.LANYARD_USER_ID) {
    try {
      const data = await fetchLanyardStatus(c.env);
      if (data) {
        const createdAt = await saveStatusSnapshot(c.env, data);
        results.status = { ok: true, created_at: createdAt };
      } else {
        throw new Error("Failed to fetch status");
      }
    } catch (error) {
      results.status = {
        ok: false,
        error: error instanceof Error ? error.message : "Status refresh failed",
      };
    }
  } else {
    results.status = { ok: false, error: "LANYARD_USER_ID not configured" };
  }

  // Refresh WakaTime
  if (c.env.WAKATIME_API_KEY) {
    try {
      await refreshWakaTime(c.env, lastWeek, today);
      await markRefreshed(c.env, "wakatime_daily");
      results.wakatime = { ok: true, start: lastWeek, end: today };
    } catch (error) {
      results.wakatime = {
        ok: false,
        error: error instanceof Error ? error.message : "WakaTime refresh failed",
      };
    }

    try {
      await refreshWakaTimeHourly(c.env, lastWeek, today);
      await markRefreshed(c.env, "wakatime_hourly");
      results.wakatime_hourly = { ok: true, start: lastWeek, end: today };
    } catch (error) {
      results.wakatime_hourly = {
        ok: false,
        error:
          error instanceof Error ? error.message : "WakaTime hourly refresh failed",
      };
    }
  } else {
    results.wakatime = { ok: false, error: "WAKATIME_API_KEY not configured" };
    results.wakatime_hourly = {
      ok: false,
      error: "WAKATIME_API_KEY not configured",
    };
  }

  // Refresh GitHub
  if (c.env.GITHUB_USERNAME && c.env.GITHUB_TOKEN) {
    try {
      await refreshGitHub(c.env, lastMonth, today);
      await markRefreshed(c.env, "github_refresh");
      results.github = { ok: true, start: lastMonth, end: today };
    } catch (error) {
      results.github = {
        ok: false,
        error: error instanceof Error ? error.message : "GitHub refresh failed",
      };
    }
  } else {
    results.github = {
      ok: false,
      error: "GITHUB_USERNAME or GITHUB_TOKEN not configured",
    };
  }

  return c.json(results);
});

export default app;
