import type { Env } from "../types/env";

// Year-level traffic for the public site's year in review: anuragd.me
// pageviews from PostHog, and Transit MCP tool calls from Cloudflare
// Analytics Engine. Each source is optional; a missing key or a failed query
// leaves that source null rather than failing the whole response.

export interface SiteTraffic {
  since: string | null;
  pageviews: number;
  visitors: number;
  countries: number;
  daily: Array<{ date: string; pageviews: number; visitors: number }>;
  top_pages: Array<{ path: string; pageviews: number }>;
  referrers: Array<{ domain: string; visitors: number }>;
  resume_downloads: number;
}

export interface TransitUsage {
  since: string | null;
  tool_calls: number;
  daily: Array<{ date: string; tool_calls: number }>;
  clients: Array<{ client: string; tool_calls: number }>;
  tools: Array<{ tool: string; tool_calls: number }>;
}

export interface YearTraffic {
  year: number;
  site: SiteTraffic | null;
  transit: TransitUsage | null;
  generated_at: string;
}

const SITE_HOSTS = ["www.anuragd.me", "anuragd.me"];

// Transit MCP's own allowlists (src/telemetry.ts in that repo). Anything else
// stays out of the response, so no raw client string can leak through.
const TRANSIT_TOOLS = [
  "find_transit", "plan_trip", "get_departures", "get_service_status", "get_vehicle_status",
  "get_station_predictions", "search_stations", "get_stations_by_line", "get_all_stations",
  "get_station_transfers", "get_incidents", "get_elevator_incidents", "get_route_info",
  "get_train_positions", "get_bus_predictions", "get_bus_routes", "get_bus_stops", "get_bus_positions",
];
const TRANSIT_CLIENTS: Record<string, string> = {
  ChatGPT: "ChatGPT",
  "openai-mcp": "ChatGPT",
  "Claude Desktop": "Claude",
  "claude-ai": "Claude",
};

type Fetch = typeof fetch;

function yearBounds(year: number) {
  return { start: `${year}-01-01 00:00:00`, end: `${year + 1}-01-01 00:00:00` };
}

// PostHog's ingestion host (us.i.posthog.com) differs from its API host.
export function posthogApiHost(host?: string) {
  const url = new URL(host || "https://us.posthog.com");
  url.hostname = url.hostname.replace(/^([a-z]+)\.i\.posthog\.com$/, "$1.posthog.com");
  return url.origin;
}

async function hogql(env: Env, query: string, fetchImpl: Fetch): Promise<unknown[][]> {
  const res = await fetchImpl(`${posthogApiHost(env.POSTHOG_HOST)}/api/projects/${env.POSTHOG_PROJECT_ID}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) throw new Error(`PostHog query failed: ${res.status}`);
  const body = (await res.json()) as { results?: unknown[][] };
  return body.results ?? [];
}

const num = (value: unknown) => (typeof value === "number" ? value : Number(value) || 0);
const day = (value: unknown) => String(value ?? "").slice(0, 10);

export async function fetchSiteTraffic(env: Env, year: number, fetchImpl: Fetch = fetch): Promise<SiteTraffic | null> {
  if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) return null;
  const { start, end } = yearBounds(year);
  const where = `timestamp >= toDateTime('${start}') AND timestamp < toDateTime('${end}') AND properties.$host IN (${SITE_HOSTS.map((h) => `'${h}'`).join(", ")})`;
  const pageviews = `event = '$pageview' AND ${where}`;

  const [summary, daily, pages, referrers, resume] = await Promise.all([
    hogql(env, `SELECT count(), count(DISTINCT person_id), count(DISTINCT properties.$geoip_country_code), min(timestamp) FROM events WHERE ${pageviews}`, fetchImpl),
    hogql(env, `SELECT toDate(timestamp) AS d, count(), count(DISTINCT person_id) FROM events WHERE ${pageviews} GROUP BY d ORDER BY d`, fetchImpl),
    hogql(env, `SELECT properties.$pathname AS p, count() AS c FROM events WHERE ${pageviews} AND p IS NOT NULL GROUP BY p ORDER BY c DESC LIMIT 25`, fetchImpl),
    hogql(env, `SELECT properties.$referring_domain AS r, count(DISTINCT person_id) AS v FROM events WHERE ${pageviews} AND r IS NOT NULL AND r NOT IN ('$direct', ${SITE_HOSTS.map((h) => `'${h}'`).join(", ")}) GROUP BY r ORDER BY v DESC LIMIT 8`, fetchImpl),
    hogql(env, `SELECT count() FROM events WHERE event = 'resume_downloaded' AND ${where}`, fetchImpl),
  ]);

  const [total = 0, visitors = 0, countries = 0, first = null] = summary[0] ?? [];
  return {
    since: first ? day(first) : null,
    pageviews: num(total),
    visitors: num(visitors),
    countries: num(countries),
    daily: daily.map(([d, views, people]) => ({ date: day(d), pageviews: num(views), visitors: num(people) })),
    top_pages: pages.map(([path, views]) => ({ path: String(path), pageviews: num(views) })),
    referrers: referrers.map(([domain, people]) => ({ domain: String(domain), visitors: num(people) })),
    resume_downloads: num(resume[0]?.[0]),
  };
}

async function analyticsSql(env: Env, sql: string, fetchImpl: Fetch): Promise<Array<Record<string, unknown>>> {
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ANALYTICS_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}` },
    body: sql,
  });
  if (!res.ok) throw new Error(`Analytics Engine query failed: ${res.status}`);
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return body.data ?? [];
}

export async function fetchTransitUsage(env: Env, year: number, fetchImpl: Fetch = fetch): Promise<TransitUsage | null> {
  if (!env.CF_ANALYTICS_ACCOUNT_ID || !env.CF_ANALYTICS_API_TOKEN) return null;
  const { start, end } = yearBounds(year);
  // production tool calls only; the prompt-eval harness labels itself and is excluded
  const rows = await analyticsSql(env, `SELECT formatDateTime(timestamp, '%Y-%m-%d', 'UTC') AS day, blob2 AS tool, blob3 AS client, SUM(_sample_interval) AS calls
FROM mcp_usage
WHERE timestamp >= toDateTime('${start}', 'UTC') AND timestamp < toDateTime('${end}', 'UTC')
  AND blob1 = 'tools/call' AND blob4 = 'production' AND blob3 != 'transit-prompt-evals'
GROUP BY day, tool, client
ORDER BY day
FORMAT JSON`, fetchImpl);

  const byDay = new Map<string, number>();
  const byClient = new Map<string, number>();
  const byTool = new Map<string, number>();
  const add = (map: Map<string, number>, key: string, n: number) => map.set(key, (map.get(key) ?? 0) + n);
  for (const row of rows) {
    const calls = Math.round(num(row.calls));
    add(byDay, String(row.day), calls);
    add(byClient, TRANSIT_CLIENTS[String(row.client)] ?? "Other", calls);
    add(byTool, TRANSIT_TOOLS.includes(String(row.tool)) ? String(row.tool) : "other", calls);
  }
  const sorted = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, tool_calls]) => ({ date, tool_calls }));
  return {
    since: daily[0]?.date ?? null,
    tool_calls: daily.reduce((s, d) => s + d.tool_calls, 0),
    daily,
    clients: sorted(byClient).map(([client, tool_calls]) => ({ client, tool_calls })),
    tools: sorted(byTool).map(([tool, tool_calls]) => ({ tool, tool_calls })),
  };
}

export async function buildYearTraffic(env: Env, year: number, fetchImpl: Fetch = fetch): Promise<YearTraffic> {
  const settle = <T>(label: string, p: Promise<T | null>) =>
    p.catch((error) => {
      console.warn(`[traffic] ${label}:`, error instanceof Error ? error.message : String(error));
      return null;
    });
  const [site, transit] = await Promise.all([
    settle("site", fetchSiteTraffic(env, year, fetchImpl)),
    settle("transit", fetchTransitUsage(env, year, fetchImpl)),
  ]);
  return { year, site, transit, generated_at: new Date().toISOString() };
}
