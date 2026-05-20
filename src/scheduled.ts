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
  const jobs = [
    { name: "lanyard", task: () => refreshLanyard(env) },
    { name: "wakatime", task: () => refreshWakaTimeIfDue(env) },
    { name: "github", task: () => refreshGitHubIfDue(env) },
  ];

  const results = await Promise.allSettled(
    jobs.map((job) => runRefreshJob(env, job.name, job.task))
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`Scheduled refresh failed: ${jobs[index].name}`, result.reason);
    }
  });
}

export async function runRefreshJob(
  env: Env,
  name: string,
  task: () => Promise<void>
): Promise<void> {
  const startedAt = new Date().toISOString();
  await markRefreshStarted(env, name, startedAt);

  try {
    await task();
    await markRefreshSucceeded(env, name, new Date().toISOString());
  } catch (error) {
    await markRefreshFailed(env, name, error, new Date().toISOString());
    throw error;
  }
}

async function markRefreshStarted(
  env: Env,
  name: string,
  startedAt: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO refresh_health (name, last_started_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       last_started_at = excluded.last_started_at,
       updated_at = excluded.updated_at`
  )
    .bind(name, startedAt, startedAt)
    .run();
}

async function markRefreshSucceeded(
  env: Env,
  name: string,
  succeededAt: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO refresh_health (
       name,
       last_success_at,
       consecutive_failures,
       updated_at
     )
     VALUES (?, ?, 0, ?)
     ON CONFLICT(name) DO UPDATE SET
       last_success_at = excluded.last_success_at,
       consecutive_failures = 0,
       updated_at = excluded.updated_at`
  )
    .bind(name, succeededAt, succeededAt)
    .run();
}

async function markRefreshFailed(
  env: Env,
  name: string,
  error: unknown,
  failedAt: string
): Promise<void> {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);

  await env.DB.prepare(
    `INSERT INTO refresh_health (
       name,
       last_error_at,
       last_error,
       consecutive_failures,
       updated_at
     )
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET
       last_error_at = excluded.last_error_at,
       last_error = excluded.last_error,
       consecutive_failures = consecutive_failures + 1,
       updated_at = excluded.updated_at`
  )
    .bind(name, failedAt, message ?? "Unknown error", failedAt)
    .run();
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
