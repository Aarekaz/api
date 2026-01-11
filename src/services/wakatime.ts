import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso, dateOnly, addDays, hourInTimezone } from "../utils/date";
import { mapJsonField } from "../utils/json";

export async function shouldRefresh(
  env: Env,
  type: string,
  minMinutes: number
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT last_run_at FROM wakatime_refresh_log WHERE type = ?"
  )
    .bind(type)
    .all();

  const lastRun =
    row.results && row.results[0]
      ? String((row.results[0] as JsonRecord).last_run_at)
      : null;

  if (!lastRun) {
    return true;
  }

  const last = Date.parse(lastRun);
  if (Number.isNaN(last)) {
    return true;
  }

  const diffMinutes = (Date.now() - last) / 60000;
  return diffMinutes >= minMinutes;
}

export async function markRefreshed(env: Env, type: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO wakatime_refresh_log (type, last_run_at)
     VALUES (?, ?)
     ON CONFLICT(type) DO UPDATE SET last_run_at = excluded.last_run_at`
  )
    .bind(type, now)
    .run();
}

export async function refreshWakaTime(
  env: Env,
  start: string,
  end: string
): Promise<void> {
  if (!env.WAKATIME_API_KEY) {
    throw new Error("WAKATIME_API_KEY not configured");
  }

  const authHeader = `Basic ${btoa(env.WAKATIME_API_KEY)}`;
  const url = new URL("https://wakatime.com/api/v1/users/current/summaries");
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);

  const response = await fetch(url.toString(), {
    headers: {
      authorization: authHeader,
      "content-type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`WakaTime request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{
      range?: { date?: string; timezone?: string };
      grand_total?: { total_seconds?: number };
      languages?: Array<{ name?: string; total_seconds?: number; percent?: number }>;
      projects?: Array<{ name?: string; total_seconds?: number; percent?: number }>;
      editors?: Array<{ name?: string; total_seconds?: number; percent?: number }>;
    }>;
  };

  const days = payload.data ?? [];
  for (const day of days) {
    const date = day.range?.date;
    if (!date) {
      continue;
    }

    const totalSeconds = day.grand_total?.total_seconds ?? 0;
    const totalMinutes = Math.round(totalSeconds / 60);
    const timezone = day.range?.timezone ?? null;
    const createdAt = nowIso();

    await env.DB.prepare(
      `INSERT INTO wakatime_days (date, total_seconds, total_minutes, timezone, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         total_seconds = excluded.total_seconds,
         total_minutes = excluded.total_minutes,
         timezone = excluded.timezone,
         created_at = excluded.created_at`
    )
      .bind(date, totalSeconds, totalMinutes, timezone, createdAt)
      .run();

    const languages = day.languages ?? [];
    for (const item of languages) {
      if (!item.name) {
        continue;
      }
      const seconds = item.total_seconds ?? 0;
      const minutes = Math.round(seconds / 60);
      await env.DB.prepare(
        `INSERT INTO wakatime_languages (date, name, total_seconds, total_minutes, percent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, name) DO UPDATE SET
           total_seconds = excluded.total_seconds,
           total_minutes = excluded.total_minutes,
           percent = excluded.percent`
      )
        .bind(date, item.name, seconds, minutes, item.percent ?? null)
        .run();
    }

    const projects = day.projects ?? [];
    for (const item of projects) {
      if (!item.name) {
        continue;
      }
      const seconds = item.total_seconds ?? 0;
      const minutes = Math.round(seconds / 60);
      await env.DB.prepare(
        `INSERT INTO wakatime_projects (date, name, total_seconds, total_minutes, percent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, name) DO UPDATE SET
           total_seconds = excluded.total_seconds,
           total_minutes = excluded.total_minutes,
           percent = excluded.percent`
      )
        .bind(date, item.name, seconds, minutes, item.percent ?? null)
        .run();
    }

    const editors = day.editors ?? [];
    for (const item of editors) {
      if (!item.name) {
        continue;
      }
      const seconds = item.total_seconds ?? 0;
      const minutes = Math.round(seconds / 60);
      await env.DB.prepare(
        `INSERT INTO wakatime_editors (date, name, total_seconds, total_minutes, percent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, name) DO UPDATE SET
           total_seconds = excluded.total_seconds,
           total_minutes = excluded.total_minutes,
           percent = excluded.percent`
      )
        .bind(date, item.name, seconds, minutes, item.percent ?? null)
        .run();
    }
  }
}

export async function refreshWakaTimeHourly(
  env: Env,
  start: string,
  end: string
): Promise<void> {
  if (!env.WAKATIME_API_KEY) {
    throw new Error("WAKATIME_API_KEY not configured");
  }

  const authHeader = `Basic ${btoa(env.WAKATIME_API_KEY)}`;
  const timezone = env.WAKATIME_TIMEZONE || "UTC";
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);

  for (
    let cursor = new Date(startDate);
    cursor <= endDate;
    cursor = addDays(cursor, 1)
  ) {
    const dateStr = dateOnly(cursor);
    const response = await fetch(
      `https://wakatime.com/api/v1/users/current/durations?date=${dateStr}`,
      {
        headers: {
          authorization: authHeader,
        },
      }
    );

    if (!response.ok) {
      continue;
    }

    const payload = (await response.json()) as {
      data?: Array<{
        time?: number;
        duration?: number;
        language?: string;
        languages?: Array<{ name?: string }>;
      }>;
    };

    const items = Array.isArray(payload.data) ? payload.data : [];
    const perHour: Array<{
      seconds: number;
      languages: Record<string, number>;
    }> = Array.from({ length: 24 }, () => ({ seconds: 0, languages: {} }));

    for (const item of items) {
      const timestamp = (item.time ?? 0) * 1000;
      const hour = hourInTimezone(timestamp, timezone);
      const duration = item.duration ?? 0;
      if (hour < 0 || hour > 23) {
        continue;
      }
      perHour[hour].seconds += duration;

      const language = item.language ?? item.languages?.[0]?.name;
      if (language) {
        perHour[hour].languages[language] =
          (perHour[hour].languages[language] ?? 0) + duration;
      }
    }

    await env.DB.prepare("DELETE FROM wakatime_hourly WHERE date = ?")
      .bind(dateStr)
      .run();

    for (let hour = 0; hour < 24; hour += 1) {
      await env.DB.prepare(
        `INSERT INTO wakatime_hourly (date, hour, seconds, languages_json)
         VALUES (?, ?, ?, ?)`
      )
        .bind(
          dateStr,
          hour,
          Math.round(perHour[hour].seconds),
          mapJsonField(perHour[hour].languages)
        )
        .run();
    }
  }
}

export async function buildWrapped(
  env: Env,
  start: string,
  end: string
): Promise<JsonRecord> {
  const [
    codingTotal,
    codingDaily,
    topLanguages,
    topProjects,
    topEditors,
    githubTotal,
    githubDaily,
    githubRepos,
  ] = await Promise.all([
    env.DB.prepare(
      "SELECT SUM(total_seconds) AS total_seconds FROM wakatime_days WHERE date BETWEEN ? AND ?"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT date, total_seconds, total_minutes FROM wakatime_days WHERE date BETWEEN ? AND ? ORDER BY date ASC"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT name, SUM(total_seconds) AS total_seconds FROM wakatime_languages WHERE date BETWEEN ? AND ? GROUP BY name ORDER BY total_seconds DESC LIMIT 10"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT name, SUM(total_seconds) AS total_seconds FROM wakatime_projects WHERE date BETWEEN ? AND ? GROUP BY name ORDER BY total_seconds DESC LIMIT 10"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT name, SUM(total_seconds) AS total_seconds FROM wakatime_editors WHERE date BETWEEN ? AND ? GROUP BY name ORDER BY total_seconds DESC LIMIT 10"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT SUM(count) AS total_count FROM github_daily WHERE date BETWEEN ? AND ?"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT date, count FROM github_daily WHERE date BETWEEN ? AND ? ORDER BY date ASC"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT repo, count FROM github_repo_totals WHERE range_start = ? AND range_end = ? ORDER BY count DESC LIMIT 10"
    )
      .bind(start, end)
      .all(),
  ]);

  const codingTotalSeconds =
    codingTotal.results && codingTotal.results[0]
      ? Number((codingTotal.results[0] as JsonRecord).total_seconds ?? 0)
      : 0;

  const githubTotalCount =
    githubTotal.results && githubTotal.results[0]
      ? Number((githubTotal.results[0] as JsonRecord).total_count ?? 0)
      : 0;

  return {
    range: { start, end },
    coding: {
      total_seconds: codingTotalSeconds,
      daily: codingDaily.results ?? [],
      top_languages: topLanguages.results ?? [],
      top_projects: topProjects.results ?? [],
      top_editors: topEditors.results ?? [],
    },
    github: {
      total_count: githubTotalCount,
      daily: githubDaily.results ?? [],
      top_repos: githubRepos.results ?? [],
    },
  };
}
