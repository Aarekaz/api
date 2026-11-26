import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshWakaTime, refreshWakaTimeHourly } from "../../services/wakatime";
import type { Env } from "../../types/env";
import { testD1, type TestD1 } from "../helpers/d1";

// What the WakaTime cron writes, from a fixed WakaTime reply: the rows in each
// table after a refresh over rows that were already there.

const NOW = "2026-11-20T12:00:00.000Z";

const SUMMARIES = {
  data: [
    {
      range: { date: "2026-11-18", timezone: "America/New_York" },
      grand_total: { total_seconds: 5430.5 },
      languages: [
        { name: "TypeScript", total_seconds: 3600, percent: 66.3 },
        { name: "Swift", total_seconds: 1830.5, percent: 33.7 },
        { total_seconds: 12 },
        { name: "Swift", total_seconds: 1900 },
      ],
      projects: [{ name: "api", total_seconds: 5430.5, percent: 100 }],
      editors: [{ name: "Xcode", total_seconds: 1830.5, percent: 33.7 }, { name: "Zed" }],
    },
    { range: {}, grand_total: { total_seconds: 1 } },
    { range: { date: "2026-11-19" } },
  ],
};

// 2026-11-18 in New York (UTC-5): 14:59:30Z is 09:59:30 local.
const DURATIONS: Record<string, unknown> = {
  "2026-11-18": {
    data: [
      { time: Date.parse("2026-11-18T14:59:30Z") / 1000, duration: 45.4, language: "TypeScript" },
      { time: Date.parse("2026-11-18T15:10:00Z") / 1000, duration: 600, languages: [{ name: "Swift" }] },
      { time: Date.parse("2026-11-18T15:20:00Z") / 1000, duration: 30, language: "TypeScript" },
      { time: Date.parse("2026-11-19T04:30:00Z") / 1000, duration: 10 },
    ],
  },
  "2026-11-19": { data: "not a list" },
};

const dump = (d1: TestD1) => Object.fromEntries(
  ["wakatime_days", "wakatime_languages", "wakatime_projects", "wakatime_editors", "wakatime_hourly"].map((table) => [
    table,
    d1.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
  ]),
);

describe("WakaTime refresh writes", () => {
  let d1: TestD1;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    d1 = testD1({
      migrations: ["0004_wakatime"],
      sql: `
        INSERT INTO wakatime_days (date, total_seconds, total_minutes, timezone, created_at)
          VALUES ('2026-11-18', 1, 0, 'UTC', '2026-01-01T00:00:00.000Z'), ('2026-11-17', 60, 1, 'UTC', '2026-01-01T00:00:00.000Z');
        INSERT INTO wakatime_languages (date, name, total_seconds, total_minutes, percent)
          VALUES ('2026-11-18', 'TypeScript', 1, 0, 1), ('2026-11-18', 'Go', 5, 0, 2);
        INSERT INTO wakatime_hourly (date, hour, seconds, languages_json)
          VALUES ('2026-11-18', 3, 999, '{}'), ('2026-11-18', 30, 1, '{}'), ('2026-11-20', 1, 7, '{}');
      `,
    });
    env = { DB: d1.DB, WAKATIME_ACCESS_TOKEN: "token", WAKATIME_TIMEZONE: "America/New_York" } as Env;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/summaries")) return Response.json(SUMMARIES);
      const date = url.searchParams.get("date")!;
      return date in DURATIONS ? Response.json(DURATIONS[date]) : new Response("no", { status: 500 });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    d1.db.close();
  });

  it("upserts each day and its languages, projects and editors", async () => {
    await refreshWakaTime(env, "2026-11-18", "2026-11-19");
    expect(dump(d1)).toMatchSnapshot();
  });

  it("replaces each fetched day's 24 hours and leaves a failed day alone", async () => {
    await refreshWakaTimeHourly(env, "2026-11-18", "2026-11-20");
    const tables = dump(d1);
    expect(tables.wakatime_hourly).toMatchSnapshot();
    const hours = tables.wakatime_hourly as Array<{ date: string }>;
    expect(hours.filter((row) => row.date === "2026-11-18")).toHaveLength(24);
    expect(hours.filter((row) => row.date === "2026-11-19")).toHaveLength(24);
    expect(hours.filter((row) => row.date === "2026-11-20")).toEqual([{ date: "2026-11-20", hour: 1, seconds: 7, languages_json: "{}" }]);
  });
});
