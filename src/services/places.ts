import { applySaved, buildChapters, type MonthCount, type MonthMode, type MonthPlace, type SavedPlace } from "./chapters";
import { bumpDataVersion } from "./data-versions";
import type { Env } from "../types/env";

/**
 * Places: visits, the journeys between them, names looked up on a device and
 * the places you saved. All of /v1/visits' SQL lives here; the route checks
 * input and shapes replies. Every write that changes a row moves the "places"
 * data version on, which is what the reads' ETags are made from.
 */

// MARK: Cleaning input

export interface VisitInput {
  latitude?: unknown; longitude?: unknown; arrived_at?: unknown; departed_at?: unknown;
  place?: unknown; address?: unknown; city?: unknown; country?: unknown; source?: unknown; source_key?: unknown;
  utc_offset?: unknown;
}

export const str = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
export const isDate = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
/** Minutes from UTC where it happened (-840…840), or null. */
const offsetIn = (v: unknown) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isInteger(n) && Math.abs(n) <= 840 ? n : null;
};

export type CleanVisit = {
  latitude: number; longitude: number; arrived_at: string; departed_at: string | null; place: string | null;
  address: string | null; city: string | null; country: string | null; source: string; source_key: string;
  utc_offset: number | null; local_date: string;
};

/**
 * Where none is known, a row's time zone is New York's (where the owner lives),
 * with its summer time; scripts/backfill-local-date.mjs uses the same.
 */
export const HOME_TIME_ZONE = "America/New_York";
const homeDate = new Intl.DateTimeFormat("en-US", { timeZone: HOME_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * The local date (YYYY-MM-DD) of a UTC instant where it happened: shifted by
 * the row's own utc_offset (minutes), or in HOME_TIME_ZONE when it has none.
 */
export function localDate(at: string, utcOffset: number | null): string {
  const ms = Date.parse(at);
  if (utcOffset !== null) return new Date(ms + utcOffset * 60_000).toISOString().slice(0, 10);
  const part = (type: string) => homeDate.formatToParts(new Date(ms)).find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function cleanVisit(v: VisitInput): CleanVisit | null {
  const lat = Number(v.latitude), lng = Number(v.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (!isDate(v.arrived_at)) return null;
  const source = str(v.source, 40);
  if (!source) return null;
  const arrived = new Date(v.arrived_at as string).toISOString();
  const departed = isDate(v.departed_at) ? new Date(v.departed_at as string).toISOString() : null;
  // A stay that ends before it starts is a report the phone got wrong (seen after a relaunch): skip it.
  if (departed && departed < arrived) return null;
  // Without a key, a visit is identified by its source, arrival and rough position.
  const key = str(v.source_key, 200) ?? `${source}:${arrived}:${lat.toFixed(3)},${lng.toFixed(3)}`;
  const utcOffset = offsetIn(v.utc_offset);
  return { latitude: lat, longitude: lng, arrived_at: arrived, departed_at: departed, place: str(v.place),
    address: str(v.address), city: str(v.city, 120), country: str(v.country, 120), source, source_key: key,
    utc_offset: utcOffset, local_date: localDate(arrived, utcOffset) };
}

export interface JourneyInput {
  started_at?: unknown; ended_at?: unknown; start_lat?: unknown; start_lng?: unknown; end_lat?: unknown; end_lng?: unknown;
  distance_m?: unknown; mode?: unknown; points?: unknown; source?: unknown; source_key?: unknown; utc_offset?: unknown;
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
  const utcOffset = offsetIn(j.utc_offset);
  return {
    started_at: started, ended_at: isDate(j.ended_at) ? new Date(j.ended_at as string).toISOString() : null,
    start_lat: num(j.start_lat), start_lng: num(j.start_lng), end_lat: num(j.end_lat), end_lng: num(j.end_lng),
    distance_m: num(j.distance_m), mode, points_json: points && points.length ? JSON.stringify(points) : null,
    source, source_key: str(j.source_key, 200) ?? `${source}:${started}:${mode ?? ""}`, utc_offset: utcOffset,
    local_date: localDate(started, utcOffset),
  };
}
export type CleanJourney = NonNullable<ReturnType<typeof cleanJourney>>;

/** How you can say you travelled. Google Timeline's words, which the rest of the data already uses. */
export const TRAVEL_MODES = ["walking", "running", "cycling", "in passenger vehicle", "in bus", "in subway", "in train", "in tram", "in ferry", "flying"] as const;

// Places you define: a centre and a radius (see services/chapters.ts applySaved).
const KINDS = ["home", "work", "school", "gym", "other", "hidden"];
const month = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(v) ? v.slice(0, 7) : null);

/** A saved place from a request body; `partial` for a change, where missing fields stay. */
export function cleanSaved(b: Record<string, unknown>, partial = false) {
  const out: Record<string, unknown> = {};
  if (b.name !== undefined || !partial) { const n = str(b.name, 120); if (!n) return null; out.name = n; }
  if (b.kind !== undefined || !partial) out.kind = KINDS.includes(String(b.kind)) ? String(b.kind) : "other";
  for (const [k, lo, hi] of [["latitude", -90, 90], ["longitude", -180, 180]] as const) {
    if (b[k] === undefined && partial) continue;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) return null;
    out[k] = v;
  }
  if (b.radius_m !== undefined || !partial) out.radius_m = Math.round(Math.min(Math.max(Number(b.radius_m) || 150, 25), 2000));
  if (b.address !== undefined) out.address = str(b.address, 300);
  if (b.starts_on !== undefined) out.starts_on = month(b.starts_on);
  if (b.ends_on !== undefined) out.ends_on = month(b.ends_on);
  if (b.note !== undefined) out.note = str(b.note, 500);
  return out;
}

export const PLACE_KEY = /^-?\d+\.\d{3},-?\d+\.\d{3}$/;

// MARK: SQL pieces

// Visits are grouped into places by a ~110 m grid cell: the key is
// printf('%.3f,%.3f', lat, lng), the same string the apps build.
const KEY = "printf('%.3f,%.3f', latitude, longitude)";
const KEY_V = KEY.replace(/latitude|longitude/g, (m) => "v." + m);

/** The reader's offset from ?offset= (minutes from UTC), 0 when missing or out of range. */
export const offsetOf = (v: string | undefined) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : 0;
};
/**
 * SQL for a row's own local time: its stored utc_offset (where it happened), or
 * the reader's offset (`param`) when unknown. `col` is the UTC column.
 */
const local = (col: string, param: string, prefix = "") =>
  `datetime(${prefix}${col}, printf('%+d minutes', COALESCE(${prefix}utc_offset, ${param})))`;

const WITH_NAME = `SELECT v.*, ${KEY_V} AS key, n.name AS place_name, n.city AS place_city
     FROM shown_visits AS v LEFT JOIN place_names AS n ON n.key = ${KEY_V}`;

const changed = (results: Array<{ meta?: { changes?: number } }>) => results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);

/** Runs statements 50 to a batch and counts the rows they changed. */
async function inBatches(env: Env, statements: D1PreparedStatement[]) {
  let n = 0;
  for (let i = 0; i < statements.length; i += 50) n += changed(await env.DB.batch(statements.slice(i, i + 50)));
  return n;
}

const placesChanged = (env: Env) => bumpDataVersion(env, "places");

// MARK: Visits

export type VisitRow = { id: number; arrived_at: string } & Record<string, unknown>;

/** Visits newest first, `limit + 1` of them so the caller can tell there's another page. */
export async function listVisits(env: Env, q: { start: string; end: string; limit: number; after?: [string, number] | null }) {
  const after = q.after ? " AND (arrived_at < ? OR (arrived_at = ? AND id < ?))" : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM shown_visits WHERE arrived_at BETWEEN ? AND ?${after} ORDER BY arrived_at DESC, id DESC LIMIT ?`,
  ).bind(q.start, q.end, ...(q.after ? [q.after[0], q.after[0], q.after[1]] : []), q.limit + 1).all<VisitRow>();
  return results;
}

export async function visitSources(env: Env) {
  const { results } = await env.DB.prepare("SELECT source, COUNT(*) AS n, MIN(arrived_at) AS first FROM visits GROUP BY source").all();
  return results;
}

/** Stores visits. A repeat is ignored, but can fill in a missing departure. Returns how many rows changed. */
export async function addVisits(env: Env, visits: CleanVisit[], now = new Date()) {
  const stamp = now.toISOString();
  const added = await inBatches(env, visits.map((v) => env.DB.prepare(
    // A repeat is ignored, except that a stop sent first on arrival gets its
    // departure filled in when the phone sends it again on leaving.
    // The local date follows the offset: a stop first sent without one moves to
    // the day where it happened once the offset arrives.
    `INSERT INTO visits (latitude, longitude, arrived_at, departed_at, place, address, city, country, source, source_key, created_at, utc_offset, local_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET departed_at = excluded.departed_at, utc_offset = COALESCE(visits.utc_offset, excluded.utc_offset),
       local_date = CASE WHEN visits.utc_offset IS NULL AND excluded.utc_offset IS NOT NULL THEN excluded.local_date
                         ELSE COALESCE(visits.local_date, excluded.local_date) END
     WHERE visits.departed_at IS NULL AND excluded.departed_at IS NOT NULL AND excluded.departed_at > visits.arrived_at`,
  ).bind(v.latitude, v.longitude, v.arrived_at, v.departed_at, v.place, v.address, v.city, v.country, v.source, v.source_key, stamp, v.utc_offset, v.local_date)));
  if (added > 0) {
    await placesChanged(env);
    // A live visit from the phone also becomes "where I am now" for Today.
    const live = visits.filter((v) => v.source === "visit").sort((a, b) => b.arrived_at.localeCompare(a.arrived_at))[0];
    if (live && now.getTime() - Date.parse(live.arrived_at) < 6 * 3600_000) {
      await env.DB.prepare(
        `INSERT INTO location_history (latitude, longitude, recorded_at, address, city, country, label, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'visit', ?, ?)`,
      ).bind(live.latitude, live.longitude, live.arrived_at, live.address, live.city, live.country, live.place, stamp, stamp).run();
    }
  }
  return added;
}

export interface VisitCorrection { hidden?: boolean; note?: string | null; moveTo?: { latitude: number; longitude: number } }

/** Your corrections on a visit. Hidden visits leave every view but stay; a moved visit keeps its old spot as the guess. */
export async function correctVisit(env: Env, id: number, change: VisitCorrection, now = new Date()) {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (change.hidden !== undefined) { sets.push("hidden_at = ?"); args.push(change.hidden ? now.toISOString() : null); }
  if (change.note !== undefined) { sets.push("note = ?"); args.push(change.note); }
  if (change.moveTo) {
    sets.push("guess_latitude = COALESCE(guess_latitude, latitude)", "guess_longitude = COALESCE(guess_longitude, longitude)", "latitude = ?", "longitude = ?");
    args.push(change.moveTo.latitude, change.moveTo.longitude);
  }
  if (!sets.length) return null;
  const row = await env.DB.prepare(`UPDATE visits SET ${sets.join(", ")} WHERE id = ? RETURNING *`).bind(...args, id).first();
  if (row) await placesChanged(env);
  return row;
}

// MARK: The map

/** Places, most visited first, from the visits in a year (YYYY) and/or a window (ISO times). */
export async function listPlaces(env: Env, window: { year?: string; from?: string; to?: string }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (window.year) { where.push("arrived_at >= ? AND arrived_at < ?"); args.push(`${window.year}-01-01`, `${Number(window.year) + 1}-01-01`); }
  if (window.from) { where.push("arrived_at >= ?"); args.push(window.from); }
  if (window.to) { where.push("arrived_at < ?"); args.push(window.to); }
  const { results } = await env.DB.prepare(`
    WITH v AS (SELECT ${KEY} AS key, * FROM shown_visits ${where.length ? "WHERE " + where.join(" AND ") : ""}),
    g AS (
      SELECT key, AVG(latitude) AS lat, AVG(longitude) AS lng, COUNT(*) AS visits,
        CAST(SUM(CASE WHEN departed_at IS NOT NULL
          THEN MIN(MAX((julianday(departed_at) - julianday(arrived_at)) * 1440, 0), 1440) ELSE 0 END) AS INTEGER) AS minutes,
        MIN(arrived_at) AS first, MAX(arrived_at) AS last,
        SUM(CASE WHEN source = 'photos' THEN 1 ELSE 0 END) AS photos,
        SUM(CASE WHEN departed_at IS NOT NULL AND (julianday(departed_at) - julianday(arrived_at)) * 1440 < 10 THEN 1 ELSE 0 END) AS brief,
        SUM(CASE WHEN (julianday(departed_at) - julianday(arrived_at)) * 24 >= 6 THEN 1 ELSE 0 END) AS long_stays
      FROM v GROUP BY key),
    p AS (SELECT key, place, COUNT(*) AS n FROM v WHERE place IS NOT NULL GROUP BY key, place),
    top AS (SELECT key, place FROM p AS a WHERE n = (SELECT MAX(n) FROM p AS b WHERE b.key = a.key) GROUP BY key),
    city AS (SELECT key, MAX(city) AS city, MAX(country) AS country FROM v WHERE city IS NOT NULL GROUP BY key)
    SELECT g.*, COALESCE(n.name, top.place) AS name, top.place AS label,
      COALESCE(n.city, city.city) AS city, COALESCE(n.country, city.country) AS country,
      n.category AS category, n.map_item_id AS map_item_id
    FROM g LEFT JOIN place_names AS n ON n.key = g.key LEFT JOIN top ON top.key = g.key LEFT JOIN city ON city.key = g.key
    ORDER BY visits DESC`).bind(...args).all();
  return results;
}

/** Visits and places per year (in each visit's own local time). */
export async function visitYears(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT substr(${local("arrived_at", "0")}, 1, 4) AS year, COUNT(*) AS visits, COUNT(DISTINCT ${KEY}) AS places
     FROM shown_visits GROUP BY year ORDER BY year`,
  ).all();
  return results;
}

/** Visits and places per month. */
export async function visitMonths(env: Env, offset: number) {
  const { results } = await env.DB.prepare(
    `SELECT substr(${local("arrived_at", "?1")}, 1, 7) AS month, COUNT(*) AS visits, COUNT(DISTINCT ${KEY}) AS places
     FROM shown_visits GROUP BY month ORDER BY month`,
  ).bind(offset).all();
  return results;
}

/** One place's visits, newest first, and its stored name. */
export async function visitsAt(env: Env, key: string) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM shown_visits WHERE ${KEY} = ? ORDER BY arrived_at DESC LIMIT 5000`,
  ).bind(key).all();
  const name = await env.DB.prepare("SELECT * FROM place_names WHERE key = ?").bind(key).first();
  return { name, visits: results };
}

/** Visits on this month and day (MM-DD) in every year. */
export async function onThisDay(env: Env, md: string, offset: number) {
  const { results } = await env.DB.prepare(
    `${WITH_NAME}
     WHERE strftime('%m-%d', ${local("arrived_at", "?1", "v.")}) = ?2 ORDER BY v.arrived_at`,
  ).bind(offset, md).all();
  return results;
}

/** Days that have visits, with counts; `year` narrows to one year. */
export async function visitDays(env: Env, year: string | null, offset: number) {
  // A day near New Year can fall in the next or previous UTC year, so read a day either side.
  const from = year ? `${Number(year) - 1}-12-31` : "0000";
  const to = year ? `${Number(year) + 1}-01-02` : "9999";
  const { results } = await env.DB.prepare(
    `SELECT day, COUNT(*) AS visits, COUNT(DISTINCT key) AS places FROM
       (SELECT date(${local("arrived_at", "?1")}) AS day, ${KEY} AS key FROM shown_visits WHERE arrived_at >= ?2 AND arrived_at < ?3)
     GROUP BY day ORDER BY day`,
  ).bind(offset, from, to).all<{ day: string }>();
  return results.filter((r) => !year || r.day.startsWith(year));
}

/** One local day: its visits (with where you woke up) and the journeys between them, in order. */
export async function visitDay(env: Env, date: string, offset: number) {
  // The day is the local day where you were: each row is read in its own offset.
  // A UTC window two days wide finds the candidates (any offset is within ±14 h).
  const near = [new Date(Date.parse(`${date}T00:00:00Z`) - 2 * 86_400_000).toISOString(),
    new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86_400_000).toISOString()];
  const visits = await env.DB.prepare(
    `${WITH_NAME}
     WHERE v.arrived_at >= ?3 AND v.arrived_at < ?4
       AND (date(${local("arrived_at", "?1", "v.")}) = ?2
         OR (date(${local("arrived_at", "?1", "v.")}) < ?2 AND v.departed_at IS NOT NULL AND date(${local("departed_at", "?1", "v.")}) >= ?2))
     ORDER BY v.arrived_at`,
  ).bind(offset, date, ...near).all();
  const journeys = await env.DB.prepare(
    `SELECT * FROM journeys WHERE started_at >= ?3 AND started_at < ?4 AND date(${local("started_at", "?1")}) = ?2 ORDER BY started_at`,
  ).bind(offset, date, ...near).all();
  // The day's own offset (where most of it happened), for the app's clock.
  const rows = visits.results as Array<{ id: number; utc_offset: number | null; arrived_at: string }>;
  const dayOffset = rows.find((r) => r.utc_offset != null)?.utc_offset ?? offset;
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - dayOffset * 60_000).toISOString();
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  // Where you woke up: the last stay that began before the day, when nothing came between
  // it and midnight (a night at home whose departure the phone never sent).
  const before = await env.DB.prepare(
    `${WITH_NAME}
     WHERE v.arrived_at < ?1 AND v.arrived_at > ?2 AND v.source != 'photos' ORDER BY v.arrived_at DESC LIMIT 1`,
  ).bind(start, new Date(Date.parse(start) - 3 * 86_400_000).toISOString()).first<{ id: number; departed_at: string | null }>();
  const list = visits.results as unknown[];
  if (before && !rows.some((r) => r.id === before.id) && (before.departed_at == null || before.departed_at > start)) {
    list.unshift({ ...before, woke_here: true });
  }
  return { date, start, end, utc_offset: dayOffset, visits: list, journeys: journeys.results };
}

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
 * All the heavy lifting is SQL; the Worker only joins the few hundred away-days.
 */
export async function listTrips(env: Env, offset: number) {
  const { results } = await env.DB.prepare(`
    WITH v AS (
      SELECT v.latitude AS lat, v.longitude AS lng, ${KEY_V} AS key, substr(${local("arrived_at", "?1", "v.")}, 1, 7) AS mo,
        date(${local("arrived_at", "?1", "v.")}) AS day, COALESCE(n.city, v.city) AS city, COALESCE(n.country, v.country) AS country
      FROM shown_visits AS v LEFT JOIN place_names AS n ON n.key = ${KEY_V}),
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
    GROUP BY v.day`).bind(offset).all();
  // Keys contain commas themselves, so pick them out by shape.
  const days = (results as unknown as Array<AwayDay & { keys_csv: string | null }>).map((d) => ({
    ...d, keys: ((d.keys_csv ?? "").match(/-?\d+\.\d{3},-?\d+\.\d{3}/g) ?? []).join("|"),
  }));
  return findTrips(days);
}

/**
 * Your footprints, for the map's heat layer: where you spent time (visits in
 * ~50 m cells, weighted by hours) and the ground you covered (every journey's
 * path but flights, flattened to [lat, lng, lat, lng, …] at ~11 m).
 */
export async function footprints(env: Env) {
  const [spots, paths] = await Promise.all([
    env.DB.prepare(`SELECT ROUND(latitude * 2000) / 2000 AS lat, ROUND(longitude * 2000) / 2000 AS lng,
        SUM(MIN(MAX(COALESCE((julianday(departed_at) - julianday(arrived_at)) * 24, 0.25), 0.1), 24)) AS hours
      FROM shown_visits GROUP BY 1, 2`).all(),
    env.DB.prepare(`SELECT mode, points_json FROM journeys
      WHERE points_json IS NOT NULL AND (mode IS NULL OR mode != 'flying')`).all(),
  ]);
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    spots: (spots.results as Array<{ lat: number; lng: number; hours: number }>)
      .map((s) => [s.lat, s.lng, Math.round(s.hours * 10) / 10]),
    paths: (paths.results as Array<{ mode: string | null; points_json: string }>).flatMap((j) => {
      try {
        const pts = JSON.parse(j.points_json) as number[][];
        return pts.length >= 2 ? [{ mode: j.mode, points: pts.flatMap((p) => [round(p[0]), round(p[1])]) }] : [];
      } catch { return []; }
    }),
  };
}

/** Every flight, oldest first: the arcs of your travels. */
export async function flights(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM journeys WHERE mode = 'flying' ORDER BY started_at").all();
  return results;
}

/** Your eras: where home was, where the days went, how you got around. See services/chapters.ts. */
export async function chapters(env: Env) {
  const db = env.DB;
  const [rows, visits, fresh, modes, saved] = await Promise.all([
    db.prepare(`
      WITH v AS (SELECT ${KEY} AS key, latitude AS lat, longitude AS lng, substr(${local("arrived_at", "0")}, 1, 7) AS mo,
        MIN(MAX((julianday(departed_at) - julianday(arrived_at)) * 24, 0), 24) AS h
        FROM shown_visits WHERE departed_at IS NOT NULL),
      mk AS (SELECT mo, key, SUM(h) AS hours, COUNT(*) AS n, AVG(lat) AS lat, AVG(lng) AS lng FROM v GROUP BY mo, key),
      r AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY mo ORDER BY hours DESC) AS rk FROM mk)
      SELECT r.mo, r.key, r.hours, r.n, r.lat, r.lng, n.name, n.city, n.country
      FROM r LEFT JOIN place_names AS n ON n.key = r.key WHERE rk <= 12 ORDER BY r.mo, rk`).all(),
    db.prepare(`SELECT substr(${local("arrived_at", "0")}, 1, 7) AS mo, COUNT(*) AS n FROM shown_visits GROUP BY mo`).all(),
    db.prepare(`SELECT substr(first, 1, 7) AS mo, COUNT(*) AS n FROM (SELECT ${KEY} AS key, MIN(${local("arrived_at", "0")}) AS first FROM shown_visits GROUP BY key) GROUP BY mo`).all(),
    db.prepare(`SELECT substr(${local("started_at", "0")}, 1, 7) AS mo, mode, SUM(distance_m) AS m FROM journeys
      WHERE distance_m IS NOT NULL AND mode NOT IN ('path', 'unknown') GROUP BY mo, mode`).all(),
    db.prepare("SELECT * FROM saved_places").all(),
  ]);
  return buildChapters(applySaved(rows.results as unknown as MonthPlace[], saved.results as unknown as SavedPlace[]), visits.results as unknown as MonthCount[],
    fresh.results as unknown as MonthCount[], modes.results as unknown as MonthMode[]);
}

// MARK: Saved places

export async function listSaved(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM saved_places ORDER BY name").all();
  return results;
}

export async function addSaved(env: Env, p: Record<string, unknown>, now = new Date()) {
  const stamp = now.toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO saved_places (name, kind, latitude, longitude, radius_m, address, starts_on, ends_on, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(p.name, p.kind, p.latitude, p.longitude, p.radius_m, p.address ?? null, p.starts_on ?? null, p.ends_on ?? null, p.note ?? null, stamp, stamp).first();
  if (row) await placesChanged(env);
  return row;
}

export async function updateSaved(env: Env, id: number, p: Record<string, unknown>, now = new Date()) {
  const fields = Object.keys(p);
  const row = await env.DB.prepare(
    `UPDATE saved_places SET ${[...fields.map((f) => `${f} = ?`), "updated_at = ?"].join(", ")} WHERE id = ? RETURNING *`,
  ).bind(...fields.map((f) => p[f] as string | number | null), now.toISOString(), id).first();
  if (row) await placesChanged(env);
  return row;
}

/** Removes a saved place (the visits stay). True when there was one. */
export async function deleteSaved(env: Env, id: number) {
  const r = await env.DB.prepare("DELETE FROM saved_places WHERE id = ?").bind(id).run();
  const deleted = (r.meta.changes ?? 0) > 0;
  if (deleted) await placesChanged(env);
  return deleted;
}

// MARK: Names

export interface PlaceNameInput { key: string; name?: unknown; city?: unknown; country?: unknown; category?: unknown; map_item_id?: unknown }

/** Names (and Apple's category and place ID) looked up on a device. Missing fields keep what's already there. */
export async function saveNames(env: Env, names: PlaceNameInput[], now = new Date()) {
  const stamp = now.toISOString();
  const n = await inBatches(env, names.map((n) => env.DB.prepare(
    `INSERT INTO place_names (key, name, city, country, category, map_item_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = COALESCE(excluded.name, name), city = COALESCE(excluded.city, city),
       country = COALESCE(excluded.country, country), category = COALESCE(excluded.category, category),
       map_item_id = COALESCE(excluded.map_item_id, map_item_id), updated_at = excluded.updated_at`,
  ).bind(n.key, str(n.name, 200), str(n.city, 120), str(n.country, 120), str(n.category, 80), str(n.map_item_id, 300), stamp)));
  if (n > 0) await placesChanged(env);
}

// MARK: Journeys

export type JourneyRow = { id: number; started_at: string } & Record<string, unknown>;

/** Trips between visits (not raw path traces), oldest first, `limit + 1` of them. */
export async function listJourneys(env: Env, q: { start: string; end: string; limit: number; after?: [string, number] | null }) {
  const after = q.after ? " AND (started_at > ? OR (started_at = ? AND id > ?))" : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM journeys WHERE started_at BETWEEN ? AND ? AND mode IS NOT NULL AND mode != 'path'${after} ORDER BY started_at, id LIMIT ?`,
  ).bind(q.start, q.end, ...(q.after ? [q.after[0], q.after[0], q.after[1]] : []), q.limit + 1).all<JourneyRow>();
  return results;
}

/** Stores journeys; repeats are ignored. Returns how many were new. */
export async function addJourneys(env: Env, journeys: CleanJourney[], now = new Date()) {
  const stamp = now.toISOString();
  const added = await inBatches(env, journeys.map((j) => env.DB.prepare(
    `INSERT OR IGNORE INTO journeys (started_at, ended_at, start_lat, start_lng, end_lat, end_lng, distance_m, mode, points_json, source, source_key, created_at, utc_offset, local_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(j.started_at, j.ended_at, j.start_lat, j.start_lng, j.end_lat, j.end_lng, j.distance_m, j.mode, j.points_json, j.source, j.source_key, stamp, j.utc_offset, j.local_date)));
  if (added > 0) await placesChanged(env);
  return added;
}

/** You know how you travelled better than the motion sensor (a bus isn't a car). */
export async function correctJourneyMode(env: Env, id: number, mode: string) {
  const row = await env.DB.prepare("UPDATE journeys SET mode = ? WHERE id = ? RETURNING *").bind(mode, id).first();
  if (row) await placesChanged(env);
  return row;
}
