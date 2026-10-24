import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { buildYearTraffic } from "../services/traffic";
import { openApiRegistry, okResponses, authSecurity, dateSchema, dateTimeSchema } from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

const yearTrafficSchema = z.object({
  year: z.number(),
  site: z.object({
    since: dateSchema.nullable(),
    pageviews: z.number(),
    visitors: z.number(),
    countries: z.number(),
    daily: z.array(z.object({ date: dateSchema, pageviews: z.number(), visitors: z.number() })),
    top_pages: z.array(z.object({ path: z.string(), pageviews: z.number() })),
    referrers: z.array(z.object({ domain: z.string(), visitors: z.number() })),
    resume_downloads: z.number(),
  }).nullable(),
  transit: z.object({
    since: dateSchema.nullable(),
    tool_calls: z.number(),
    daily: z.array(z.object({ date: dateSchema, tool_calls: z.number() })),
    clients: z.array(z.object({ client: z.string(), tool_calls: z.number() })),
    tools: z.array(z.object({ tool: z.string(), tool_calls: z.number() })),
  }).nullable(),
  generated_at: dateTimeSchema,
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/traffic/{year}",
  summary: "Get a year of site traffic (PostHog) and Transit MCP usage (Analytics Engine)",
  security: authSecurity,
  request: { params: z.object({ year: z.string() }) },
  responses: okResponses(yearTrafficSchema),
});

// Both upstreams are slow and rate limited; an hour-old answer is plenty.
const CACHE_SECONDS = 3600;

app.get("/:year", async (c) => {
  const year = Number(c.req.param("year"));
  const current = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < 2025 || year > current) return c.json({ error: "Unsupported year" }, 400);

  const cacheKey = new Request(`https://cache.internal/v1/traffic/${year}`);
  const cache = typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default;
  const hit = await cache?.match(cacheKey);
  if (hit) return c.json(await hit.json());

  const traffic = await buildYearTraffic(c.env, year);
  if (cache && (traffic.site || traffic.transit)) {
    c.executionCtx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(traffic), { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` } })));
  }
  return c.json(traffic);
});

export default app;
