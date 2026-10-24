import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/env";
import { buildYearTraffic, fetchSiteViews, fetchTransitUsage } from "../../services/traffic";

const env = (extra: Partial<Env> = {}) => extra as Env;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("fetchSiteViews", () => {
  it("looks up the zone and sums daily page views", async () => {
    let body: { variables: Record<string, string> } | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/zones?name=anuragd.me")) return json({ result: [{ id: "zone-1" }] });
      body = JSON.parse(String(init?.body));
      return json({ data: { viewer: { zones: [{ httpRequests1dGroups: [
        { dimensions: { date: "2026-06-01" }, sum: { pageViews: 120 } },
        { dimensions: { date: "2026-06-02" }, sum: { pageViews: 80 } },
      ] }] } } });
    });
    const site = await fetchSiteViews(env({ CF_ANALYTICS_API_TOKEN: "t" }), 2026, fetchImpl as unknown as typeof fetch);
    expect(body!.variables).toEqual({ zone: "zone-1", start: "2026-01-01", end: "2026-12-31" });
    expect(site).toEqual({ zone: "anuragd.me", page_views: 200, daily: [{ date: "2026-06-01", page_views: 120 }, { date: "2026-06-02", page_views: 80 }] });
  });
});

describe("fetchTransitUsage", () => {
  it("groups production tool calls by day, platform, and allowlisted tool", async () => {
    let sql = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sql = String(init.body);
      return json({ data: [
        { day: "2026-08-01", tool: "get_departures", client: "ChatGPT", calls: 10 },
        { day: "2026-08-01", tool: "plan_trip", client: "claude-ai", calls: 4 },
        { day: "2026-08-02", tool: "secret-tool", client: "someone@example.com", calls: 3 },
        { day: "2026-08-02", tool: "get_departures", client: "openai-mcp", calls: 2.4 },
      ] });
    });
    const usage = await fetchTransitUsage(env({ CF_ANALYTICS_ACCOUNT_ID: "acct", CF_ANALYTICS_API_TOKEN: "t" }), 2026, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql");
    expect(sql).toContain("blob4 = 'production'");
    expect(sql).toContain("blob3 != 'transit-prompt-evals'");
    expect(usage).toEqual({
      since: "2026-08-01",
      tool_calls: 19,
      daily: [{ date: "2026-08-01", tool_calls: 14 }, { date: "2026-08-02", tool_calls: 5 }],
      clients: [{ client: "ChatGPT", tool_calls: 12 }, { client: "Claude", tool_calls: 4 }, { client: "Other", tool_calls: 3 }],
      tools: [{ tool: "get_departures", tool_calls: 12 }, { tool: "plan_trip", tool_calls: 4 }, { tool: "other", tool_calls: 3 }],
    });
    expect(JSON.stringify(usage)).not.toContain("someone@example.com");
  });
});

describe("buildYearTraffic", () => {
  it("returns null usage when the query fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => json({}, 500));
    const result = await buildYearTraffic(env({ CF_ANALYTICS_ACCOUNT_ID: "a", CF_ANALYTICS_API_TOKEN: "t" }), 2026, fetchImpl as unknown as typeof fetch);
    expect(result.transit).toBeNull();
    expect(result.site).toBeNull();
    warn.mockRestore();
  });

  it("is skipped without keys", async () => {
    const fetchImpl = vi.fn();
    expect((await buildYearTraffic(env(), 2026, fetchImpl as unknown as typeof fetch)).transit).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
