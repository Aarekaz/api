import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/env";
import { buildYearTraffic, fetchSiteTraffic, fetchTransitUsage, posthogApiHost } from "../../services/traffic";

const env = (extra: Partial<Env> = {}) => extra as Env;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("posthogApiHost", () => {
  it("maps the ingestion host to the API host", () => {
    expect(posthogApiHost("https://us.i.posthog.com")).toBe("https://us.posthog.com");
    expect(posthogApiHost("https://eu.i.posthog.com")).toBe("https://eu.posthog.com");
    expect(posthogApiHost(undefined)).toBe("https://us.posthog.com");
  });
});

describe("fetchSiteTraffic", () => {
  it("is skipped without keys", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchSiteTraffic(env(), 2026, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shapes PostHog results and only counts production pageviews", async () => {
    const queries: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)).query;
      queries.push(query);
      if (query.includes("min(timestamp)")) return json({ results: [[1200, 340, 21, "2026-08-16T14:00:00Z"]] });
      if (query.includes("toDate(timestamp)")) return json({ results: [["2026-08-16", 40, 12]] });
      if (query.includes("$pathname")) return json({ results: [["/", 500], ["/blog/agent-harnesses-explained", 210]] });
      if (query.includes("$referring_domain")) return json({ results: [["news.ycombinator.com", 90]] });
      return json({ results: [[7]] });
    });
    const site = await fetchSiteTraffic(env({ POSTHOG_PERSONAL_API_KEY: "k", POSTHOG_PROJECT_ID: "42", POSTHOG_HOST: "https://us.i.posthog.com" }), 2026, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://us.posthog.com/api/projects/42/query/");
    expect(site).toEqual({
      since: "2026-08-16",
      pageviews: 1200,
      visitors: 340,
      countries: 21,
      daily: [{ date: "2026-08-16", pageviews: 40, visitors: 12 }],
      top_pages: [{ path: "/", pageviews: 500 }, { path: "/blog/agent-harnesses-explained", pageviews: 210 }],
      referrers: [{ domain: "news.ycombinator.com", visitors: 90 }],
      resume_downloads: 7,
    });
    for (const q of queries) expect(q).toContain("properties.$host IN ('www.anuragd.me', 'anuragd.me')");
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
  it("keeps one source when the other fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string) => (String(url).includes("posthog") ? json({}, 500) : json({ data: [] })));
    const result = await buildYearTraffic(env({ POSTHOG_PERSONAL_API_KEY: "k", POSTHOG_PROJECT_ID: "1", CF_ANALYTICS_ACCOUNT_ID: "a", CF_ANALYTICS_API_TOKEN: "t" }), 2026, fetchImpl as unknown as typeof fetch);
    expect(result.site).toBeNull();
    expect(result.transit).toEqual({ since: null, tool_calls: 0, daily: [], clients: [], tools: [] });
    warn.mockRestore();
  });
});
