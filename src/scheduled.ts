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
  // Fetch and save status snapshot
  const data = await fetchLanyardStatus(env);
  if (data) {
    await saveStatusSnapshot(env, data);
  }

  // Refresh WakaTime data
  try {
    if (!env.WAKATIME_API_KEY) {
      return;
    }

    const today = dateOnly(new Date());
    const latest = await env.DB.prepare(
      "SELECT date FROM wakatime_days ORDER BY date DESC LIMIT 1"
    ).all();
    const latestDate =
      latest.results && latest.results[0]
        ? String((latest.results[0] as JsonRecord).date)
        : null;

    if (latestDate === today) {
      if (!(await shouldRefresh(env, "wakatime_hourly", 60))) {
        return;
      }

      const start = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -6));
      await refreshWakaTimeHourly(env, start, today);
      await markRefreshed(env, "wakatime_hourly");
      return;
    }

    const start = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -6));
    await refreshWakaTime(env, start, today);
    await markRefreshed(env, "wakatime_daily");
    if (await shouldRefresh(env, "wakatime_hourly", 60)) {
      await refreshWakaTimeHourly(env, start, today);
      await markRefreshed(env, "wakatime_hourly");
    }
  } catch {
    // Silently fail WakaTime refresh
  }

  // Refresh GitHub data
  try {
    if (!env.GITHUB_TOKEN || !env.GITHUB_USERNAME) {
      return;
    }

    if (!(await shouldRefresh(env, "github_refresh", 1440))) {
      return;
    }

    const end = dateOnly(new Date());
    const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));
    await refreshGitHub(env, start, end);
    await markRefreshed(env, "github_refresh");
  } catch {
    // Silently fail GitHub refresh
  }
}
