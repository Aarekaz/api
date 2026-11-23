import { Hono } from "hono";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";

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
      COALESCE(n.city, city.city) AS city, COALESCE(n.country, city.country) AS country
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

const toRad = (d: number) => (d * Math.PI) / 180;
export function distanceKm(a: [number, number], b: [number, number]) {
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

interface Row { latitude: number; longitude: number; arrived_at: string; key: string; city: string | null; country: string | null }

/** Group days spent far from home into trips. Home is the most-visited place of that era. */
export function findTrips(rows: Row[], offsetMinutes = 0, awayKm = 100) {
  if (rows.length === 0) return [];
  // Home changes over the years (moving countries), so use the most-visited place per year.
  const homeByYear = new Map<string, [number, number]>();
  const byYear = new Map<string, Map<string, { n: number; at: [number, number] }>>();
  for (const r of rows) {
    const y = r.arrived_at.slice(0, 4);
    const m = byYear.get(y) ?? new Map();
    const e = m.get(r.key) ?? { n: 0, at: [r.latitude, r.longitude] as [number, number] };
    e.n += 1; m.set(r.key, e); byYear.set(y, m);
  }
  for (const [y, m] of byYear) homeByYear.set(y, [...m.values()].sort((a, b) => b.n - a.n)[0].at);
  const local = (iso: string) => new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString().slice(0, 10);
  const away = rows.filter((r) => distanceKm(homeByYear.get(r.arrived_at.slice(0, 4))!, [r.latitude, r.longitude]) > awayKm);
  away.sort((a, b) => a.arrived_at.localeCompare(b.arrived_at));
  type Trip = { start: string; end: string; rows: Row[] };
  const trips: Trip[] = [];
  for (const r of away) {
    const day = local(r.arrived_at);
    const last = trips[trips.length - 1];
    if (last && (Date.parse(day) - Date.parse(last.end)) / 86_400_000 <= 1) { last.end = day; last.rows.push(r); }
    else trips.push({ start: day, end: day, rows: [r] });
  }
  return trips.map((t) => {
    const lat = t.rows.reduce((s, r) => s + r.latitude, 0) / t.rows.length;
    const lng = t.rows.reduce((s, r) => s + r.longitude, 0) / t.rows.length;
    const cities = new Map<string, number>();
    for (const r of t.rows) if (r.city) cities.set(r.city, (cities.get(r.city) ?? 0) + 1);
    const city = [...cities.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const lats = t.rows.map((r) => r.latitude), lngs = t.rows.map((r) => r.longitude);
    return {
      start: t.start, end: t.end, days: Math.round((Date.parse(t.end) - Date.parse(t.start)) / 86_400_000) + 1,
      visits: t.rows.length, places: new Set(t.rows.map((r) => r.key)).size, lat, lng, city,
      country: t.rows.find((r) => r.country)?.country ?? null,
      bounds: { min_lat: Math.min(...lats), max_lat: Math.max(...lats), min_lng: Math.min(...lngs), max_lng: Math.max(...lngs) },
    };
  }).reverse();
}

/** Trips: days more than 100 km from home, grouped. ?offset=-300 */
app.get("/trips", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT v.latitude, v.longitude, v.arrived_at, ${KEY.replace(/latitude|longitude/g, (m) => "v." + m)} AS key,
       COALESCE(n.city, v.city) AS city, COALESCE(n.country, v.country) AS country
     FROM visits AS v LEFT JOIN place_names AS n ON n.key = ${KEY.replace(/latitude|longitude/g, (m) => "v." + m)}`,
  ).all();
  cached(c, 600);
  return c.json({ trips: findTrips(results as unknown as Row[], offsetOf(c.req.query("offset"))) });
});

/** POST { names: [{ key, name, city, country }] }: names looked up on a device. */
app.post("/names", async (c) => {
  const body = (await parseJson(c.req.raw)) as { names?: unknown } | null;
  const list = Array.isArray(body?.names) ? (body!.names as Array<Record<string, unknown>>) : null;
  if (!list || list.length === 0 || list.length > 500) return c.json({ error: "Send names: 1 to 500 items" }, 400);
  const now = new Date().toISOString();
  const valid = list.filter((n) => typeof n.key === "string" && /^-?\d+\.\d{3},-?\d+\.\d{3}$/.test(n.key));
  const statements = valid.map((n) => c.env.DB.prepare(
    `INSERT INTO place_names (key, name, city, country, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = COALESCE(excluded.name, name), city = COALESCE(excluded.city, city),
       country = COALESCE(excluded.country, country), updated_at = excluded.updated_at`,
  ).bind(n.key, str(n.name, 200), str(n.city, 120), str(n.country, 120), now));
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
