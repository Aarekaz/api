import type { Env } from "../types/env";

// Year-level numbers for the public site's year in review, all from
// Cloudflare with one read-only analytics token: page views for the site's
// zone, and Transit MCP tool calls from Analytics Engine. Without the token,
// or if a query fails, that part is null rather than an error.

export interface TransitUsage {
  since: string | null;
  tool_calls: number;
  daily: Array<{ date: string; tool_calls: number }>;
  clients: Array<{ client: string; tool_calls: number }>;
  tools: Array<{ tool: string; tool_calls: number }>;
}

export interface SiteViews {
  zone: string;
  page_views: number;
  daily: Array<{ date: string; page_views: number }>;
}

export interface YearTraffic {
  year: number;
  site: SiteViews | null;
  transit: TransitUsage | null;
  generated_at: string;
}

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

const num = (value: unknown) => (typeof value === "number" ? value : Number(value) || 0);

const CF_API = "https://api.cloudflare.com/client/v4";

export async function fetchSiteViews(env: Env, year: number, fetchImpl: Fetch = fetch): Promise<SiteViews | null> {
  if (!env.CF_ANALYTICS_API_TOKEN) return null;
  const zone = env.CF_SITE_ZONE || "anuragd.me";
  const headers = { Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}`, "Content-Type": "application/json" };
  const lookup = await fetchImpl(`${CF_API}/zones?name=${encodeURIComponent(zone)}`, { headers });
  if (!lookup.ok) throw new Error(`Zone lookup failed: ${lookup.status}`);
  const zoneId = ((await lookup.json()) as { result?: Array<{ id: string }> }).result?.[0]?.id;
  if (!zoneId) return null;

  // daily groups cover the whole zone and keep a year of history
  const query = `query ($zone: String!, $start: Date!, $end: Date!) { viewer { zones(filter: {zoneTag: $zone}) {
    httpRequests1dGroups(limit: 366, filter: {date_geq: $start, date_leq: $end}, orderBy: [date_ASC]) { dimensions { date } sum { pageViews } } } } }`;
  const res = await fetchImpl(`${CF_API}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: { zone: zoneId, start: `${year}-01-01`, end: `${year}-12-31` } }),
  });
  if (!res.ok) throw new Error(`Zone analytics failed: ${res.status}`);
  const body = (await res.json()) as { errors?: unknown[]; data?: { viewer?: { zones?: Array<{ httpRequests1dGroups?: Array<{ dimensions: { date: string }; sum: { pageViews: number } }> }> } } };
  if (body.errors?.length) throw new Error("Zone analytics returned errors");
  const daily = (body.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? []).map((g) => ({ date: g.dimensions.date, page_views: num(g.sum.pageViews) }));
  return { zone, page_views: daily.reduce((s, d) => s + d.page_views, 0), daily };
}

async function analyticsSql(env: Env, sql: string, fetchImpl: Fetch): Promise<Array<Record<string, unknown>>> {
  const res = await fetchImpl(`${CF_API}/accounts/${env.CF_ANALYTICS_ACCOUNT_ID}/analytics_engine/sql`, {
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
    settle("site", fetchSiteViews(env, year, fetchImpl)),
    settle("transit", fetchTransitUsage(env, year, fetchImpl)),
  ]);
  return { year, site, transit, generated_at: new Date().toISOString() };
}
