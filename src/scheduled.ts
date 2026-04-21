import type { Env } from "./types/env";
import type { JsonRecord } from "./types/common";
import { dateOnly, addDays } from "./utils/date";
import { fetchLanyardStatus, saveStatusSnapshot } from "./services/lanyard";
import {
  refreshWakaTime,
  refreshWakaTimeHourly,
  shouldRefresh,
  markRefreshed,
} from "./services/wakatime";
import { refreshGitHub } from "./services/github";

export async function handleScheduled(
  _event: ScheduledEvent,
  env: Env
): Promise<void> {
  // Each refresh runs independently. Previously the WakaTime block had
  // early `return`s that exited the whole handler, so GitHub would never
  // refresh on cron ticks where today's WakaTime row already existed —
  // i.e. most of the day.
  await Promise.allSettled([
    refreshLanyard(env),
    refreshWakaTimeIfDue(env),
    refreshGitHubIfDue(env),
  ]);
}

async function refreshLanyard(env: Env): Promise<void> {
  const data = await fetchLanyardStatus(env);
  if (data) {
    await saveStatusSnapshot(env, data);
  }
}

async function refreshWakaTimeIfDue(env: Env): Promise<void> {
  if (!env.WAKATIME_API_KEY) return;

  const today = dateOnly(new Date());
  const latest = await env.DB.prepare(
    "SELECT date FROM wakatime_days ORDER BY date DESC LIMIT 1"
  ).all();
  const latestDate =
    latest.results && latest.results[0]
      ? String((latest.results[0] as JsonRecord).date)
      : null;

  // Today's daily row already exists → only refresh hourly (and only if
  // the 60-min interval has elapsed). Skips upstream daily refresh to
  // stay within WakaTime rate limits.
  if (latestDate === today) {
    if (!(await shouldRefresh(env, "wakatime_hourly", 60))) return;
    const start = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -6));
    await refreshWakaTimeHourly(env, start, today);
    await markRefreshed(env, "wakatime_hourly");
    return;
  }

  // First refresh of the day (or backfilling a missed day) → fetch daily
  // and conditionally hourly.
  const start = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -6));
  await refreshWakaTime(env, start, today);
  await markRefreshed(env, "wakatime_daily");
  if (await shouldRefresh(env, "wakatime_hourly", 60)) {
    await refreshWakaTimeHourly(env, start, today);
    await markRefreshed(env, "wakatime_hourly");
  }
}

async function refreshGitHubIfDue(env: Env): Promise<void> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_USERNAME) return;

  // GitHub GraphQL is generous (5000 req/h on a personal token) and we
  // care about today's commits showing up promptly on /projects, so
  // refresh every 30 min instead of every 24h.
  if (!(await shouldRefresh(env, "github_refresh", 30))) return;

  const end = dateOnly(new Date());
  const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));
  await refreshGitHub(env, start, end);
  await markRefreshed(env, "github_refresh");
}
