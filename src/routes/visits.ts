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

export default app;
