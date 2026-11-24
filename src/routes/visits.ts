import { Hono } from "hono";
import { buildChapters, type MonthCount, type MonthMode, type MonthPlace } from "../services/chapters";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { z } from "zod";
import {
  authSecurity,
  dateSchema,
  openApiJsonRequestBody,
  openApiRegistry,
  okResponses,
} from "../schemas/openapi";

// /v1/visits: places you've been. The phone posts visits as they happen;
// imports (photos, Google Timeline) post them in batches. Safe to repeat.
const app = new Hono<{ Bindings: Env }>();

interface VisitInput {
  latitude?: unknown; longitude?: unknown; arrived_at?: unknown; departed_at?: unknown;
  place?: unknown; address?: unknown; city?: unknown; country?: unknown; source?: unknown; source_key?: unknown;
}

const str = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const isDate = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

export function cleanVisit(v: VisitInput): null | {
  latitude: number; longitude: number; arrived_at: string; departed_at: string | null; place: string | null;
  address: string | null; city: string | null; country: string | null; source: string; source_key: string;
} {
  const lat = Number(v.latitude), lng = Number(v.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (!isDate(v.arrived_at)) return null;
  const source = str(v.source, 40);
  if (!source) return null;
  const arrived = new Date(v.arrived_at as string).toISOString();
  const departed = isDate(v.departed_at) ? new Date(v.departed_at as string).toISOString() : null;
  // Without a key, a visit is identified by its source, arrival and rough position.
  const key = str(v.source_key, 200) ?? `${source}:${arrived}:${lat.toFixed(3)},${lng.toFixed(3)}`;
  return { latitude: lat, longitude: lng, arrived_at: arrived, departed_at: departed, place: str(v.place),
    address: str(v.address), city: str(v.city, 120), country: str(v.country, 120), source, source_key: key };
}

// OpenAPI registrations. Posted visits and journeys are cleaned, not
// validated: invalid items are skipped and counted in `valid`.
const placeKey = z.string().regex(/^-?\d+\.\d{3},-?\d+\.\d{3}$/).openapi({
  description: "Grid cell of about 110 m: printf('%.3f,%.3f', lat, lng)",
  example: "38.898,-77.037",
});
const offset = z.coerce.number().int().min(-840).max(840).optional().openapi({
  description: "Local minutes from UTC (default 0)",
});

const visitSchema = z.object({
  id: z.number().int(),
  latitude: z.number(),
  longitude: z.number(),
  arrived_at: z.string(),
  departed_at: z.string().nullable(),
  place: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  source: z.string(),
  source_key: z.string(),
  created_at: z.string(),
});
const visitWithNameSchema = visitSchema.extend({
  key: z.string(),
  place_name: z.string().nullable(),
  place_city: z.string().nullable(),
});

const placeNameSchema = z.object({
  key: z.string(),
  name: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  category: z.string().nullable(),
  map_item_id: z.string().nullable(),
  updated_at: z.string(),
});

const journeySchema = z.object({
  id: z.number().int(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  start_lat: z.number().nullable(),
  start_lng: z.number().nullable(),
  end_lat: z.number().nullable(),
  end_lng: z.number().nullable(),
  distance_m: z.number().nullable(),
  mode: z.string().nullable(),
  points_json: z.string().nullable().openapi({ description: "JSON array of [lat, lng(, t)] points" }),
  source: z.string(),
  source_key: z.string(),
  created_at: z.string(),
});

const batchResultSchema = z.object({
  received: z.number().int(),
  valid: z.number().int(),
  added: z.number().int().openapi({ description: "New rows; repeats are ignored" }),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits",
  summary: "List visits, newest first, with counts per source",
  security: authSecurity,
  request: {
    query: z.object({
      start: z.string().optional().openapi({ description: "ISO time (default the beginning)" }),
      end: z.string().optional().openapi({ description: "ISO time (default now)" }),
      limit: z.coerce.number().int().min(1).max(5000).optional().openapi({ description: "Default 500" }),
    }),
  },
  responses: okResponses(z.object({
    visits: z.array(visitSchema),
    sources: z.array(z.object({ source: z.string(), n: z.number().int(), first: z.string() })),
  })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/visits",
  summary: "Add visits (up to 500 at a time; safe to repeat)",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      visits: z.array(z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        arrived_at: z.string(),
        departed_at: z.string().nullable().optional(),
        place: z.string().max(300).nullable().optional(),
        address: z.string().max(300).nullable().optional(),
        city: z.string().max(120).nullable().optional(),
        country: z.string().max(120).nullable().optional(),
        source: z.string().max(40).openapi({ description: "\"visit\" for live visits from the phone" }),
        source_key: z.string().max(200).nullable().optional(),
      })).min(1).max(500),
    })),
  },
  responses: okResponses(batchResultSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/places",
  summary: "List places (grouped visits), most visited first",
  security: authSecurity,
  request: {
    query: z.object({
      year: z.string().regex(/^\d{4}$/).optional(),
      from: z.string().optional().openapi({ description: "ISO time" }),
      to: z.string().optional().openapi({ description: "ISO time" }),
    }),
  },
  responses: okResponses(z.object({
    places: z.array(z.object({
      key: z.string(),
      lat: z.number(),
      lng: z.number(),
      visits: z.number().int(),
      minutes: z.number().int().openapi({ description: "Time spent, each visit capped at a day" }),
      first: z.string(),
      last: z.string(),
      name: z.string().nullable(),
      label: z.string().nullable(),
      city: z.string().nullable(),
      country: z.string().nullable(),
      category: z.string().nullable(),
      map_item_id: z.string().nullable(),
    })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/years",
  summary: "Count visits and places per year",
  security: authSecurity,
  responses: okResponses(z.object({
    years: z.array(z.object({ year: z.string(), visits: z.number().int(), places: z.number().int() })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/months",
  summary: "Count visits and places per month",
  security: authSecurity,
  request: { query: z.object({ offset }) },
  responses: okResponses(z.object({
    months: z.array(z.object({ month: z.string(), visits: z.number().int(), places: z.number().int() })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/at",
  summary: "List one place's visits, newest first",
  security: authSecurity,
  request: { query: z.object({ key: placeKey }) },
  responses: okResponses(z.object({
    key: z.string(),
    name: placeNameSchema.nullable(),
    visits: z.array(visitSchema),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/on-this-day",
  summary: "List visits on this month and day in every year",
  security: authSecurity,
  request: {
    query: z.object({
      md: z.string().regex(/^\d{2}-\d{2}$/).openapi({ example: "11-23" }),
      offset,
    }),
  },
  responses: okResponses(z.object({ visits: z.array(visitWithNameSchema) })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/days",
  summary: "List days that have visits, with counts",
  security: authSecurity,
  request: { query: z.object({ year: z.string().regex(/^\d{4}$/).optional(), offset }) },
  responses: okResponses(z.object({
    days: z.array(z.object({ day: dateSchema, visits: z.number().int(), places: z.number().int() })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/day",
  summary: "Get one local day's visits and the journeys between them",
  security: authSecurity,
  request: { query: z.object({ date: dateSchema.openapi({ example: "2024-05-01" }), offset }) },
  responses: okResponses(z.object({
    date: dateSchema,
    start: z.string(),
    end: z.string(),
    visits: z.array(visitWithNameSchema),
    journeys: z.array(journeySchema),
  })),
});

const chapterPlace = z.object({
  key: z.string(), name: z.string().nullable(), city: z.string().nullable(), country: z.string().nullable(),
  lat: z.number(), lng: z.number(), hours: z.number(), visits: z.number().int(),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/flights",
  summary: "List every flight (journeys flown), oldest first",
  security: authSecurity,
  responses: okResponses(z.object({ flights: z.array(z.record(z.string(), z.unknown())) })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/chapters",
  summary: "Your eras: where home was each stretch, where the days went, the places you kept going to, how you got around",
  security: authSecurity,
  responses: okResponses(z.object({
    chapters: z.array(z.object({
      start: z.string().openapi({ description: "First month, YYYY-MM" }),
      end: z.string().openapi({ description: "Last month, YYYY-MM" }),
      months: z.number().int(),
      city: z.string().nullable(),
      country: z.string().nullable(),
      home: chapterPlace,
      anchor: chapterPlace.nullable().openapi({ description: "Where most days went (school, work), if anywhere stands out" }),
      haunts: z.array(chapterPlace),
      visits: z.number().int(),
      newPlaces: z.number().int(),
      km: z.number().openapi({ description: "Distance moved on the ground" }),
      modes: z.array(z.object({ mode: z.string(), km: z.number() })),
    })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/visits/trips",
  summary: "List trips: days roughly 100 km or more from home, grouped",
  security: authSecurity,
  request: { query: z.object({ offset }) },
  responses: okResponses(z.object({
    trips: z.array(z.object({
      start: dateSchema,
      end: dateSchema,
      days: z.number().int(),
      visits: z.number().int(),
      places: z.number().int(),
      lat: z.number(),
      lng: z.number(),
      city: z.string().nullable(),
      country: z.string().nullable(),
      bounds: z.object({
        min_lat: z.number(),
        max_lat: z.number(),
        min_lng: z.number(),
        max_lng: z.number(),
      }),
    })),
  })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/visits/names",
  summary: "Save place names looked up on a device (up to 500)",
  description: "Missing fields keep what's already stored. Items with an invalid key are skipped.",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      names: z.array(z.object({
        key: placeKey,
        name: z.string().max(200).nullable().optional(),
        city: z.string().max(120).nullable().optional(),
        country: z.string().max(120).nullable().optional(),
        category: z.string().max(80).nullable().optional(),
        map_item_id: z.string().max(300).nullable().optional(),
      })).min(1).max(500),
    })),
  },
  responses: okResponses(z.object({ received: z.number().int(), saved: z.number().int() })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/visits/journeys",
  summary: "Add journeys (up to 500 at a time; safe to repeat)",
  security: authSecurity,
  request: {
    body: openApiJsonRequestBody(z.object({
      journeys: z.array(z.object({
        started_at: z.string(),
        ended_at: z.string().nullable().optional(),
        start_lat: z.number().nullable().optional(),
        start_lng: z.number().nullable().optional(),
        end_lat: z.number().nullable().optional(),
        end_lng: z.number().nullable().optional(),
        distance_m: z.number().nullable().optional(),
        mode: z.string().max(40).nullable().optional(),
        points: z.array(z.array(z.number()).min(2).max(3)).max(2000).nullable().optional()
          .openapi({ description: "[lat, lng] or [lat, lng, t] points" }),
        source: z.string().max(40),
        source_key: z.string().max(200).nullable().optional(),
      })).min(1).max(500),
    })),
  },
  responses: okResponses(batchResultSchema),
});

app.get("/", async (c) => {
  const end = isDate(c.req.query("end")) ? new Date(c.req.query("end")!).toISOString() : new Date().toISOString();
  const start = isDate(c.req.query("start")) ? new Date(c.req.query("start")!).toISOString() : "1970-01-01T00:00:00.000Z";
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 500, 1), 5000);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM visits WHERE arrived_at BETWEEN ? AND ? ORDER BY arrived_at DESC LIMIT ?",
  ).bind(start, end, limit).all();
  const counts = await c.env.DB.prepare("SELECT source, COUNT(*) AS n, MIN(arrived_at) AS first FROM visits GROUP BY source").all();
  return c.json({ visits: results, sources: counts.results });
});

/** POST { visits: [...] } up to 500 at a time. Repeats are ignored. */
app.post("/", async (c) => {
  const body = (await parseJson(c.req.raw)) as { visits?: unknown } | null;
  const list = Array.isArray(body?.visits) ? (body!.visits as VisitInput[]) : null;
  if (!list || list.length === 0 || list.length > 500) return c.json({ error: "Send visits: 1 to 500 items" }, 400);
  const clean = list.map(cleanVisit).filter((v): v is NonNullable<ReturnType<typeof cleanVisit>> => v !== null);
  const now = new Date().toISOString();
  const statements = clean.map((v) => c.env.DB.prepare(
    `INSERT OR IGNORE INTO visits (latitude, longitude, arrived_at, departed_at, place, address, city, country, source, source_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(v.latitude, v.longitude, v.arrived_at, v.departed_at, v.place, v.address, v.city, v.country, v.source, v.source_key, now));
  let added = 0;
  for (let i = 0; i < statements.length; i += 50) {
    const results = await c.env.DB.batch(statements.slice(i, i + 50));
    added += results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  }
  // A live visit from the phone also becomes "where I am now" for Today.
  const live = clean.filter((v) => v.source === "visit").sort((a, b) => b.arrived_at.localeCompare(a.arrived_at))[0];
  if (live && added > 0 && Date.now() - Date.parse(live.arrived_at) < 6 * 3600_000) {
    await c.env.DB.prepare(
      `INSERT INTO location_history (latitude, longitude, recorded_at, address, city, country, label, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'visit', ?, ?)`,
    ).bind(live.latitude, live.longitude, live.arrived_at, live.address, live.city, live.country, live.place, now, now).run();
  }
  return c.json({ received: list.length, valid: clean.length, added });
});


// ---------------------------------------------------------------------------
// The map. Visits are grouped into places by a ~110 m grid cell: the key is
// printf('%.3f,%.3f', lat, lng), the same string the apps build.

const KEY = "printf('%.3f,%.3f', latitude, longitude)";
const offsetOf = (v: string | undefined) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : 0;
};
const modifier = (minutes: number) => `${minutes >= 0 ? "+" : ""}${minutes} minutes`;
const cached = (c: { header: (k: string, v: string) => void }, seconds: number) =>
  c.header("Cache-Control", `private, max-age=${seconds}`);

/** Places, most visited first. ?year=2024 or ?from=&to= (ISO) narrow the visits counted. */
app.get("/places", async (c) => {
  const where: string[] = [];
  const args: unknown[] = [];
  const year = c.req.query("year");
  if (year && /^\d{4}$/.test(year)) { where.push("arrived_at >= ? AND arrived_at < ?"); args.push(`${year}-01-01`, `${Number(year) + 1}-01-01`); }
  if (isDate(c.req.query("from"))) { where.push("arrived_at >= ?"); args.push(new Date(c.req.query("from")!).toISOString()); }
  if (isDate(c.req.query("to"))) { where.push("arrived_at < ?"); args.push(new Date(c.req.query("to")!).toISOString()); }
  const { results } = await c.env.DB.prepare(`
    WITH v AS (SELECT ${KEY} AS key, * FROM visits ${where.length ? "WHERE " + where.join(" AND ") : ""}),
    g AS (
      SELECT key, AVG(latitude) AS lat, AVG(longitude) AS lng, COUNT(*) AS visits,
        CAST(SUM(CASE WHEN departed_at IS NOT NULL
          THEN MIN(MAX((julianday(departed_at) - julianday(arrived_at)) * 1440, 0), 1440) ELSE 0 END) AS INTEGER) AS minutes,
        MIN(arrived_at) AS first, MAX(arrived_at) AS last
      FROM v GROUP BY key),
    p AS (SELECT key, place, COUNT(*) AS n FROM v WHERE place IS NOT NULL GROUP BY key, place),
    top AS (SELECT key, place FROM p AS a WHERE n = (SELECT MAX(n) FROM p AS b WHERE b.key = a.key) GROUP BY key),
    city AS (SELECT key, MAX(city) AS city, MAX(country) AS country FROM v WHERE city IS NOT NULL GROUP BY key)
    SELECT g.*, COALESCE(n.name, top.place) AS name, top.place AS label,
      COALESCE(n.city, city.city) AS city, COALESCE(n.country, city.country) AS country,
      n.category AS category, n.map_item_id AS map_item_id
    FROM g LEFT JOIN place_names AS n ON n.key = g.key LEFT JOIN top ON top.key = g.key LEFT JOIN city ON city.key = g.key
    ORDER BY visits DESC`).bind(...args).all();
  cached(c, 300);
  return c.json({ places: results });
});

/** Visits per year, for the map's year scrubber. */
app.get("/years", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT substr(arrived_at, 1, 4) AS year, COUNT(*) AS visits, COUNT(DISTINCT ${KEY}) AS places
     FROM visits GROUP BY year ORDER BY year`,
  ).all();
  cached(c, 300);
  return c.json({ years: results });
});

/** Visits per month, for the map's timeline. ?offset= minutes from UTC for local months. */
app.get("/months", async (c) => {
  const shift = modifier(offsetOf(c.req.query("offset")));
  const { results } = await c.env.DB.prepare(
    `SELECT substr(datetime(arrived_at, ?), 1, 7) AS month, COUNT(*) AS visits, COUNT(DISTINCT ${KEY}) AS places
     FROM visits GROUP BY month ORDER BY month`,
  ).bind(shift).all();
  cached(c, 300);
  return c.json({ months: results });
});

/** One place's visits, newest first. ?key=38.898,-77.037 */
app.get("/at", async (c) => {
  const key = c.req.query("key") ?? "";
  if (!/^-?\d+\.\d{3},-?\d+\.\d{3}$/.test(key)) return c.json({ error: "key must look like 38.898,-77.037" }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM visits WHERE ${KEY} = ? ORDER BY arrived_at DESC LIMIT 5000`,
  ).bind(key).all();
  const name = await c.env.DB.prepare("SELECT * FROM place_names WHERE key = ?").bind(key).first();
  return c.json({ key, name, visits: results });
});

/** Where you were on this date in past years. ?md=11-23&offset=-300 (local minutes from UTC). */
app.get("/on-this-day", async (c) => {
  const md = c.req.query("md") ?? "";
  if (!/^\d{2}-\d{2}$/.test(md)) return c.json({ error: "md must look like 11-23" }, 400);
  const offset = offsetOf(c.req.query("offset"));
  const { results } = await c.env.DB.prepare(
    `SELECT v.*, ${KEY.replace(/latitude|longitude/g, (m) => "v." + m)} AS key, n.name AS place_name, n.city AS place_city
     FROM visits AS v LEFT JOIN place_names AS n ON n.key = ${KEY.replace(/latitude|longitude/g, (m) => "v." + m)}
     WHERE strftime('%m-%d', v.arrived_at, ?) = ? ORDER BY v.arrived_at`,
  ).bind(modifier(offset), md).all();
  return c.json({ visits: results });
});

/** Days that have visits, with counts. ?year=2024&offset=-300 */
app.get("/days", async (c) => {
  const offset = offsetOf(c.req.query("offset"));
  const year = c.req.query("year");
  const ok = !!year && /^\d{4}$/.test(year);
  // A day near New Year can fall in the next or previous UTC year, so read a day either side.
  const from = ok ? `${Number(year) - 1}-12-31` : "0000";
  const to = ok ? `${Number(year) + 1}-01-02` : "9999";
  const { results } = await c.env.DB.prepare(
    `SELECT day, COUNT(*) AS visits, COUNT(DISTINCT key) AS places FROM
       (SELECT strftime('%Y-%m-%d', arrived_at, ?1) AS day, ${KEY} AS key FROM visits WHERE arrived_at >= ?2 AND arrived_at < ?3)
     GROUP BY day ORDER BY day`,
  ).bind(modifier(offset), from, to).all();
  const rows = (results as Array<{ day: string }>).filter((r) => !ok || r.day.startsWith(year!));
  cached(c, 300);
  return c.json({ days: rows });
});

/** One day: its visits and the journeys between them, in order. ?date=2024-05-01&offset=-240 */
app.get("/day", async (c) => {
  const date = c.req.query("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "date must look like 2024-05-01" }, 400);
  const offset = offsetOf(c.req.query("offset"));
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - offset * 60_000).toISOString();
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const visits = await c.env.DB.prepare(
    `SELECT v.*, ${KEY.replace(/latitude|longitude/g, (m) => "v." + m)} AS key, n.name AS place_name, n.city AS place_city
     FROM visits AS v LEFT JOIN place_names AS n ON n.key = ${KEY.replace(/latitude|longitude/g, (m) => "v." + m)}
     WHERE (v.arrived_at >= ?1 AND v.arrived_at < ?2) OR (v.arrived_at < ?1 AND v.departed_at > ?1)
     ORDER BY v.arrived_at`,
  ).bind(start, end).all();
  const journeys = await c.env.DB.prepare(
    "SELECT * FROM journeys WHERE started_at >= ? AND started_at < ? ORDER BY started_at",
  ).bind(start, end).all();
  return c.json({ date, start, end, visits: visits.results, journeys: journeys.results });
});

export interface AwayDay {
  day: string; visits: number; lat: number; lng: number;
  min_lat: number; max_lat: number; min_lng: number; max_lng: number;
  keys: string | null; cities: string | null; countries: string | null;
}

/** Days away from home (computed in SQL), joined into trips when no more than a day apart. */
export function findTrips(days: AwayDay[]) {
  type Trip = { start: string; end: string; days: AwayDay[] };
  const trips: Trip[] = [];
  for (const d of [...days].sort((a, b) => a.day.localeCompare(b.day))) {
    const last = trips[trips.length - 1];
    if (last && (Date.parse(d.day) - Date.parse(last.end)) / 86_400_000 <= 2) { last.end = d.day; last.days.push(d); }
    else trips.push({ start: d.day, end: d.day, days: [d] });
  }
  const top = (lists: Array<string | null>) => {
    const counts = new Map<string, number>();
    for (const list of lists) for (const x of (list ?? "").split("|")) if (x) counts.set(x, (counts.get(x) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  return trips.map((t) => {
    const visits = t.days.reduce((s, d) => s + d.visits, 0);
    return {
      start: t.start, end: t.end, days: Math.round((Date.parse(t.end) - Date.parse(t.start)) / 86_400_000) + 1,
      visits, places: new Set(t.days.flatMap((d) => (d.keys ?? "").split("|").filter(Boolean))).size,
      lat: t.days.reduce((s, d) => s + d.lat * d.visits, 0) / visits,
      lng: t.days.reduce((s, d) => s + d.lng * d.visits, 0) / visits,
      city: top(t.days.map((d) => d.cities)), country: top(t.days.map((d) => d.countries)),
      bounds: {
        min_lat: Math.min(...t.days.map((d) => d.min_lat)), max_lat: Math.max(...t.days.map((d) => d.max_lat)),
        min_lng: Math.min(...t.days.map((d) => d.min_lng)), max_lng: Math.max(...t.days.map((d) => d.max_lng)),
      },
    };
  }).reverse();
}

/**
 * Trips: days spent roughly 100 km or more from home, grouped. Home is the busiest place over a
 * three-month window, so moving cities doesn't turn your new life into one long trip.
 * All the heavy lifting is SQL; the Worker only joins the few hundred away-days. ?offset=-300
 */
/** Every flight, oldest first: the arcs of your travels. */
app.get("/flights", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM journeys WHERE mode = 'flying' ORDER BY started_at",
  ).all();
  cached(c, 3600);
  return c.json({ flights: results });
});

/** Your eras: where home was, where the days went, how you got around. See services/chapters.ts. */
app.get("/chapters", async (c) => {
  const db = c.env.DB;
  const [rows, visits, fresh, modes] = await Promise.all([
    db.prepare(`
      WITH v AS (SELECT ${KEY} AS key, latitude AS lat, longitude AS lng, substr(arrived_at, 1, 7) AS mo,
        MIN(MAX((julianday(departed_at) - julianday(arrived_at)) * 24, 0), 24) AS h
        FROM visits WHERE departed_at IS NOT NULL),
      mk AS (SELECT mo, key, SUM(h) AS hours, COUNT(*) AS n, AVG(lat) AS lat, AVG(lng) AS lng FROM v GROUP BY mo, key),
      r AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY mo ORDER BY hours DESC) AS rk FROM mk)
      SELECT r.mo, r.key, r.hours, r.n, r.lat, r.lng, n.name, n.city, n.country
      FROM r LEFT JOIN place_names AS n ON n.key = r.key WHERE rk <= 12 ORDER BY r.mo, rk`).all(),
    db.prepare(`SELECT substr(arrived_at, 1, 7) AS mo, COUNT(*) AS n FROM visits GROUP BY mo`).all(),
    db.prepare(`SELECT substr(first, 1, 7) AS mo, COUNT(*) AS n FROM (SELECT ${KEY} AS key, MIN(arrived_at) AS first FROM visits GROUP BY key) GROUP BY mo`).all(),
    db.prepare(`SELECT substr(started_at, 1, 7) AS mo, mode, SUM(distance_m) AS m FROM journeys
      WHERE distance_m IS NOT NULL AND mode NOT IN ('path', 'unknown') GROUP BY mo, mode`).all(),
  ]);
  cached(c, 3600);
  return c.json({
    chapters: buildChapters(rows.results as unknown as MonthPlace[], visits.results as unknown as MonthCount[],
      fresh.results as unknown as MonthCount[], modes.results as unknown as MonthMode[]),
  });
});

app.get("/trips", async (c) => {
  const keyV = KEY.replace(/latitude|longitude/g, (m) => "v." + m);
  const { results } = await c.env.DB.prepare(`
    WITH v AS (
      SELECT v.latitude AS lat, v.longitude AS lng, ${keyV} AS key, substr(v.arrived_at, 1, 7) AS mo,
        strftime('%Y-%m-%d', v.arrived_at, ?1) AS day, COALESCE(n.city, v.city) AS city, COALESCE(n.country, v.country) AS country
      FROM visits AS v LEFT JOIN place_names AS n ON n.key = ${keyV}),
    mk AS (SELECT mo, key, COUNT(*) AS n, AVG(lat) AS lat, AVG(lng) AS lng FROM v GROUP BY mo, key),
    months AS (SELECT DISTINCT mo FROM v),
    win AS (
      SELECT m.mo, k.key, SUM(k.n) AS n, AVG(k.lat) AS lat, AVG(k.lng) AS lng
      FROM months AS m JOIN mk AS k
        ON k.mo BETWEEN substr(date(m.mo || '-01', '-1 month'), 1, 7) AND substr(date(m.mo || '-01', '+1 month'), 1, 7)
      GROUP BY m.mo, k.key),
    ranked AS (SELECT mo, lat, lng, ROW_NUMBER() OVER (PARTITION BY mo ORDER BY n DESC) AS r FROM win),
    home AS (SELECT mo, lat, lng FROM ranked WHERE r = 1)
    SELECT v.day, COUNT(*) AS visits, AVG(v.lat) AS lat, AVG(v.lng) AS lng,
      MIN(v.lat) AS min_lat, MAX(v.lat) AS max_lat, MIN(v.lng) AS min_lng, MAX(v.lng) AS max_lng,
      group_concat(DISTINCT v.key) AS keys_csv, group_concat(v.city, '|') AS cities, group_concat(v.country, '|') AS countries
    FROM v JOIN home AS h ON h.mo = v.mo
    WHERE abs(v.lat - h.lat) > 0.9 OR abs(v.lng - h.lng) > 1.1
    GROUP BY v.day`).bind(modifier(offsetOf(c.req.query("offset")))).all();
  // Keys contain commas themselves, so pick them out by shape.
  const days = (results as unknown as Array<AwayDay & { keys_csv: string | null }>).map((d) => ({
    ...d, keys: ((d.keys_csv ?? "").match(/-?\d+\.\d{3},-?\d+\.\d{3}/g) ?? []).join("|"),
  }));
  cached(c, 600);
  return c.json({ trips: findTrips(days) });
});

/**
 * POST { names: [{ key, name?, city?, country?, category?, map_item_id? }] }:
 * names (and Apple's category and place ID) looked up on a device. Missing
 * fields keep what's already there.
 */
app.post("/names", async (c) => {
  const body = (await parseJson(c.req.raw)) as { names?: unknown } | null;
  const list = Array.isArray(body?.names) ? (body!.names as Array<Record<string, unknown>>) : null;
  if (!list || list.length === 0 || list.length > 500) return c.json({ error: "Send names: 1 to 500 items" }, 400);
  const now = new Date().toISOString();
  const valid = list.filter((n) => typeof n.key === "string" && /^-?\d+\.\d{3},-?\d+\.\d{3}$/.test(n.key));
  const statements = valid.map((n) => c.env.DB.prepare(
    `INSERT INTO place_names (key, name, city, country, category, map_item_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = COALESCE(excluded.name, name), city = COALESCE(excluded.city, city),
       country = COALESCE(excluded.country, country), category = COALESCE(excluded.category, category),
       map_item_id = COALESCE(excluded.map_item_id, map_item_id), updated_at = excluded.updated_at`,
  ).bind(n.key, str(n.name, 200), str(n.city, 120), str(n.country, 120), str(n.category, 80), str(n.map_item_id, 300), now));
  for (let i = 0; i < statements.length; i += 50) await c.env.DB.batch(statements.slice(i, i + 50));
  return c.json({ received: list.length, saved: valid.length });
});

interface JourneyInput {
  started_at?: unknown; ended_at?: unknown; start_lat?: unknown; start_lng?: unknown; end_lat?: unknown; end_lng?: unknown;
  distance_m?: unknown; mode?: unknown; points?: unknown; source?: unknown; source_key?: unknown;
}
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function cleanJourney(j: JourneyInput) {
  if (!isDate(j.started_at)) return null;
  const source = str(j.source, 40);
  if (!source) return null;
  const started = new Date(j.started_at as string).toISOString();
  const points = Array.isArray(j.points)
    ? (j.points as unknown[]).filter((p): p is number[] => Array.isArray(p) && p.length >= 2 && p.every((x) => Number.isFinite(Number(x))))
        .slice(0, 2000).map((p) => p.slice(0, 3).map(Number))
    : null;
  const mode = str(j.mode, 40)?.toLowerCase() ?? null;
  return {
    started_at: started, ended_at: isDate(j.ended_at) ? new Date(j.ended_at as string).toISOString() : null,
    start_lat: num(j.start_lat), start_lng: num(j.start_lng), end_lat: num(j.end_lat), end_lng: num(j.end_lng),
    distance_m: num(j.distance_m), mode, points_json: points && points.length ? JSON.stringify(points) : null,
    source, source_key: str(j.source_key, 200) ?? `${source}:${started}:${mode ?? ""}`,
  };
}

/** POST { journeys: [...] } up to 500 at a time. Repeats are ignored. */
app.post("/journeys", async (c) => {
  const body = (await parseJson(c.req.raw)) as { journeys?: unknown } | null;
  const list = Array.isArray(body?.journeys) ? (body!.journeys as JourneyInput[]) : null;
  if (!list || list.length === 0 || list.length > 500) return c.json({ error: "Send journeys: 1 to 500 items" }, 400);
  const clean = list.map(cleanJourney).filter((j): j is NonNullable<ReturnType<typeof cleanJourney>> => j !== null);
  const now = new Date().toISOString();
  const statements = clean.map((j) => c.env.DB.prepare(
    `INSERT OR IGNORE INTO journeys (started_at, ended_at, start_lat, start_lng, end_lat, end_lng, distance_m, mode, points_json, source, source_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(j.started_at, j.ended_at, j.start_lat, j.start_lng, j.end_lat, j.end_lng, j.distance_m, j.mode, j.points_json, j.source, j.source_key, now));
  let added = 0;
  for (let i = 0; i < statements.length; i += 50) {
    const results = await c.env.DB.batch(statements.slice(i, i + 50));
    added += results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  }
  return c.json({ received: list.length, valid: clean.length, added });
});

export default app;
