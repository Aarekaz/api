import type { Env } from "../types/env";
import { shiftDay } from "../utils/date";
import { firstArrivalsStatement, listPlaces, visitDays } from "./places";
import { JOURNAL_WHEN, wordsBetween } from "./journal-words";

/**
 * One period of Wrapped (from..to, local days, inclusive, in `tz`) worked out
 * from D1 in one pass, for GET /v1/wrapped/summary. It carries what the app's
 * WrappedStore used to gather from ~29 requests (WakaTime, GitHub, training,
 * WHOOP and Apple Health, places, music, the shelf diary, links and
 * highlights, posts and documents, the journal), already cut to the period
 * and summed; the app keeps its own presentation (streaks, "fullest day").
 *
 * The independent reads go in one D1 batch; places and the journal reuse
 * their services and run beside it.
 *
 * Local days and hours come from `tz` (IANA). Music and reading are bucketed
 * by UTC hour in SQL and then placed in `tz`, so a zone that is not a whole
 * number of hours from UTC can put a play near midnight on the next day.
 */

export type WrappedPeriod = { from: string; to: string; tz: string };
type Ranked = { name: string; value: number; detail?: string };
type Row = Record<string, unknown>;

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0)) || 0;
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const top = (rows: Ranked[], limit = 50) => rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)).slice(0, limit);

/** Local day and hour of an instant in `tz`. */
export function zoneClock(tz: string): (at: string | number) => { day: string; hour: number } {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  });
  return (at) => {
    const parts = format.formatToParts(new Date(at));
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) % 24 };
  };
}

/** How far `tz`'s wall clock is ahead of UTC at an instant (ms). */
function zoneOffsetMs(tz: string, ms: number): number {
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(clock.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const whole = Math.floor(ms / 1000) * 1000;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - whole;
}

/** The instant a local day starts in `tz` (ISO). */
export function startOfDay(day: string, tz: string): string {
  const midnight = Date.parse(`${day}T00:00:00Z`);
  let guess = midnight - zoneOffsetMs(tz, midnight);
  guess = midnight - zoneOffsetMs(tz, guess);
  return new Date(guess).toISOString();
}

/** Minutes from UTC in `tz` at an instant (what the places reads take as `offset`). */
export function offsetMinutes(tz: string, at: string): number {
  return Math.round(zoneOffsetMs(tz, Date.parse(at)) / 60_000);
}

/** WHOOP's sport names ("weightlifting_msk", "hiit") as words, as the app shows them. */
export function sportName(raw: unknown): string {
  let name = typeof raw === "string" ? raw.toLowerCase() : "";
  if (!name) return "Activity";
  name = name.replace(/_msk/g, "").replace(/[_-]/g, " ");
  if (name === "hiit" || name === "f45") return name.toUpperCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const words = (text: unknown) => (typeof text === "string" ? text.split(/\s+/).filter(Boolean).length : 0);

export async function wrappedSummary(
  env: Env,
  period: WrappedPeriod,
  trips: (offset: number) => Promise<Row[]> = async () => [],
) {
  const { from, to, tz } = period;
  const start = startOfDay(from, tz);
  const until = startOfDay(shiftDay(to, 1), tz);
  const inDays = (day: string | null) => !!day && day >= from && day <= to;
  const inPeriod = (at: unknown) => {
    const ms = typeof at === "string" ? Date.parse(at) : NaN;
    return Number.isFinite(ms) && ms >= Date.parse(start) && ms < Date.parse(until);
  };
  // Date-only values ("2026-11-24") and mixed formats are read a day either side, then cut exactly.
  const padStart = shiftDay(from, -1), padUntil = shiftDay(to, 2);
  const clock = zoneClock(tz);
  const DB = env.DB;
  const whoopTime = (sql: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${sql})`;

  const statements = [
    /* 0 */ DB.prepare("SELECT date, total_seconds FROM wakatime_days WHERE date BETWEEN ? AND ?").bind(from, to),
    /* 1 */ DB.prepare("SELECT name, SUM(total_seconds) AS seconds FROM wakatime_languages WHERE date BETWEEN ? AND ? GROUP BY name").bind(from, to),
    /* 2 */ DB.prepare("SELECT name, SUM(total_seconds) AS seconds FROM wakatime_projects WHERE date BETWEEN ? AND ? GROUP BY name").bind(from, to),
    /* 3 */ DB.prepare("SELECT name, SUM(total_seconds) AS seconds FROM wakatime_editors WHERE date BETWEEN ? AND ? GROUP BY name").bind(from, to),
    /* 4 */ DB.prepare("SELECT date, hour, seconds FROM wakatime_hourly WHERE date BETWEEN ? AND ?").bind(from, to),
    /* 5 */ DB.prepare("SELECT date, count FROM github_daily WHERE date BETWEEN ? AND ? AND count > 0").bind(from, to),
    /* 6 */ DB.prepare(
      `SELECT s.day, r.name AS routine, COUNT(*) AS sets, MIN(s.done_at) AS started_at, MAX(s.done_at) AS ended_at,
         ROUND(SUM(COALESCE(s.weight, 0) * COALESCE(s.reps, 0))) AS volume FROM training_sets AS s
       LEFT JOIN training_routines AS r ON r.id = s.routine_id WHERE s.day BETWEEN ? AND ? GROUP BY s.day, s.routine_id ORDER BY s.day`,
    ).bind(from, to),
    /* 7 */ DB.prepare(
      `SELECT start_at, end_at, sport_name, CASE WHEN score_state = 'SCORED' THEN strain END AS strain, distance_meter
       FROM whoop_workouts WHERE deleted_at IS NULL AND ${whoopTime("COALESCE(start_at, upstream_created_at)")} >= ? AND ${whoopTime("COALESCE(start_at, upstream_created_at)")} < ?`,
    ).bind(start, until),
    /* 8 */ DB.prepare(
      `SELECT AVG(recovery_score) AS recovery, AVG(resting_heart_rate) AS resting_hr, AVG(hrv_rmssd_milliseconds) AS hrv, COUNT(*) AS n
       FROM whoop_recoveries WHERE deleted_at IS NULL AND score_state = 'SCORED'
         AND ${whoopTime("upstream_created_at")} >= ? AND ${whoopTime("upstream_created_at")} < ?`,
    ).bind(start, until),
    /* 9 */ DB.prepare(
      `SELECT end_at, (COALESCE(stage_light_milliseconds, 0) + COALESCE(stage_slow_wave_milliseconds, 0) + COALESCE(stage_rem_milliseconds, 0)) / 1000.0 AS asleep
       FROM whoop_sleeps WHERE deleted_at IS NULL AND COALESCE(nap, 0) = 0 AND end_at >= ? AND end_at < ?`,
    ).bind(start, until),
    /* 10 */ DB.prepare(
      "SELECT date, steps, distance_walking_running, sleep_duration_minutes, resting_heart_rate FROM apple_health_daily WHERE date BETWEEN ? AND ?",
    ).bind(from, to),
    /* 11 */ DB.prepare(
      "SELECT COUNT(*) AS plays, COALESCE(SUM(duration_ms), 0) AS ms, (SELECT MIN(played_at) FROM music_plays) AS since FROM music_plays WHERE played_at >= ? AND played_at < ?",
    ).bind(start, until),
    /* 12 */ DB.prepare(
      "SELECT COALESCE(artists, 'Unknown') AS name, COUNT(*) AS plays FROM music_plays WHERE played_at >= ? AND played_at < ? GROUP BY name ORDER BY plays DESC LIMIT 50",
    ).bind(start, until),
    /* 13 */ DB.prepare(
      `SELECT track_id, MAX(track) AS track, MAX(artists) AS artist, COUNT(*) AS plays FROM music_plays
       WHERE played_at >= ? AND played_at < ? GROUP BY track_id ORDER BY plays DESC LIMIT 50`,
    ).bind(start, until),
    /* 14 */ DB.prepare(
      "SELECT substr(played_at, 1, 13) AS hour, COUNT(*) AS plays FROM music_plays WHERE played_at >= ? AND played_at < ? GROUP BY hour",
    ).bind(start, until),
    /* 15 */ DB.prepare(
      // Two indexed reads (documents_created, links_read_at) rather than one OR that scans every link.
      `SELECT l.document_id, d.created_at, l.read_at, l.reading_minutes, l.site FROM links l JOIN documents d ON d.id = l.document_id
       WHERE d.deleted_at IS NULL AND d.created_at >= ? AND d.created_at < ?
       UNION
       SELECT l.document_id, d.created_at, l.read_at, l.reading_minutes, l.site FROM links l JOIN documents d ON d.id = l.document_id
       WHERE d.deleted_at IS NULL AND l.read_at >= ? AND l.read_at < ?`,
    ).bind(padStart, padUntil, padStart, padUntil),
    /* 16 */ DB.prepare(
      `SELECT h.text, h.note, h.document_id, h.created_at, d.title FROM highlights h JOIN documents d ON d.id = h.document_id
       WHERE h.deleted_at IS NULL AND d.deleted_at IS NULL AND h.created_at >= ? AND h.created_at < ? ORDER BY h.created_at DESC, h.id DESC`,
    ).bind(padStart, padUntil),
    /* 17 */ DB.prepare("SELECT title, content, published_at FROM posts WHERE published_at >= ? AND published_at < ?").bind(padStart, padUntil),
    /* 18 */ DB.prepare(
      "SELECT kind, created_at FROM documents WHERE deleted_at IS NULL AND kind IN ('note', 'writing') AND created_at >= ? AND created_at < ?",
    ).bind(padStart, padUntil),
    /* 19 */ DB.prepare(
      `SELECT l.*, s.type AS type, s.title AS title, s.author AS author, s.image_url AS image_url, s.cover_override_url AS cover_override_url
       FROM shelf_log l JOIN shelf_items s ON s.id = l.item_id WHERE l.logged_at >= ? AND l.logged_at < ? ORDER BY l.logged_at DESC, l.id DESC`,
    ).bind(padStart, padUntil),
    /* 20 */ DB.prepare(
      `SELECT id, type, title, author, image_url, cover_override_url, rating, completed_at, last_watched_at FROM shelf_items
       WHERE status IN ('completed', 'watched')
         AND ((completed_at >= ? AND completed_at < ?) OR (completed_at IS NULL AND last_watched_at >= ? AND last_watched_at < ?))`,
    ).bind(padStart, padUntil, padStart, padUntil),
    /* 21 */ firstArrivalsStatement(env),
  ];

  const offset = offsetMinutes(tz, start);
  const years = [...new Set([from.slice(0, 4), to.slice(0, 4)])];
  const [batch, periodPlaces, dayRows, journalRows, tripRows] = await Promise.all([
    DB.batch(statements),
    listPlaces(env, { from: start, to: until }),
    Promise.all(years.map((year) => visitDays(env, year, offset))),
    wordsBetween(env, JOURNAL_WHEN, `${padStart}T00:00:00.000Z`, `${padUntil}T00:00:00.000Z`),
    trips(offset).catch(() => [] as Row[]),
  ]);
  const rows = (i: number) => (batch[i]?.results ?? []) as Row[];

  // Coding (WakaTime days are already local days).
  const codeDaily: Record<string, number> = {};
  for (const r of rows(0)) codeDaily[String(r.date)] = (codeDaily[String(r.date)] ?? 0) + num(r.total_seconds);
  const ranked = (i: number) => top(rows(i)
    .filter((r) => num(r.seconds) >= 60 && !["Other", "Unknown"].includes(String(r.name)))
    .map((r) => ({ name: String(r.name), value: num(r.seconds) / 3600 })));
  const hours = Array(24).fill(0) as number[];
  const weekdays = Array(7).fill(0) as number[]; // Monday first
  for (const r of rows(4)) {
    const hour = num(r.hour);
    if (hour < 0 || hour > 23) continue;
    const h = num(r.seconds) / 3600;
    hours[hour] += h;
    weekdays[(new Date(`${r.date}T00:00:00Z`).getUTCDay() + 6) % 7] += h;
  }

  // GitHub.
  const githubDaily: Record<string, number> = {};
  for (const r of rows(5)) githubDaily[String(r.date)] = (githubDaily[String(r.date)] ?? 0) + num(r.count);

  // Training.
  const sessions = rows(6).map((r) => {
    const a = Date.parse(String(r.started_at)), b = Date.parse(String(r.ended_at));
    return {
      day: String(r.day), routine: str(r.routine) ?? "Workout", sets: num(r.sets), volume: num(r.volume),
      minutes: Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 60_000 : null,
    };
  });

  // Body: WHOOP first, Apple Health for what WHOOP doesn't have.
  const activities = rows(7).filter((r) => inPeriod(r.start_at)).map((r) => {
    const startMs = Date.parse(String(r.start_at)), endMs = Date.parse(String(r.end_at));
    return {
      day: clock(String(r.start_at)).day, sport: sportName(r.sport_name),
      seconds: Number.isFinite(endMs) ? Math.max(0, (endMs - startMs) / 1000) : 0,
      strain: r.strain == null ? null : num(r.strain), meters: r.distance_meter == null ? null : num(r.distance_meter),
    };
  }).sort((a, b) => a.day.localeCompare(b.day));
  const sleep: Record<string, number> = {};
  for (const r of rows(9)) {
    if (num(r.asleep) <= 3600) continue;
    const day = clock(String(r.end_at)).day;
    sleep[day] = (sleep[day] ?? 0) + num(r.asleep) / 3600;
  }
  const steps: Record<string, number> = {};
  let walkingKm = 0;
  const healthResting: number[] = [];
  for (const r of rows(10)) {
    const day = String(r.date).slice(0, 10);
    if (!inDays(day)) continue;
    if (num(r.steps) > 0) steps[day] = num(r.steps);
    walkingKm += num(r.distance_walking_running);
    if (sleep[day] === undefined && num(r.sleep_duration_minutes) > 60) sleep[day] = num(r.sleep_duration_minutes) / 60;
    if (r.resting_heart_rate != null) healthResting.push(num(r.resting_heart_rate));
  }
  const recovery = rows(8)[0] ?? {};
  const whoopRecoveries = num(recovery.n) > 0;
  const average = (list: number[]) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

  // Places.
  const firstEver = new Map(rows(21).map((r) => [String(r.key), String(r.first)]));
  const countries = new Set<string>();
  const places = (periodPlaces as Row[]).filter((r) => num(r.visits) > 0).map((r) => {
    const key = String(r.key);
    const city = str(r.city);
    if (str(r.country)) countries.add(String(r.country));
    return {
      key, name: str(r.name) ?? str(r.label) ?? city ?? "Unnamed place", city, country: str(r.country),
      visits: num(r.visits), minutes: num(r.minutes), is_new: (firstEver.get(key) ?? String(r.first ?? "")) >= start,
    };
  });
  const placesPerDay: Record<string, number> = {};
  for (const r of dayRows.flat() as Row[]) if (inDays(String(r.day))) placesPerDay[String(r.day)] = num(r.places);
  const placeTrips = tripRows
    .filter((t) => str(t.start) && str(t.end) && String(t.end) >= from && String(t.start) <= to)
    .map((t) => ({
      start: String(t.start) > from ? String(t.start) : from, end: String(t.end) < to ? String(t.end) : to,
      days: num(t.days) || 1, city: str(t.city), country: str(t.country),
    }))
    .sort((a, b) => a.start.localeCompare(b.start));

  // Music, bucketed by UTC hour then placed in tz.
  const musicTotals = rows(11)[0] ?? {};
  const musicPerDay: Record<string, number> = {};
  const musicHours = Array(24).fill(0) as number[];
  for (const r of rows(14)) {
    const local = clock(`${r.hour}:00:00Z`);
    musicPerDay[local.day] = (musicPerDay[local.day] ?? 0) + num(r.plays);
    musicHours[local.hour] += num(r.plays);
  }

  // Library: the diary's finishes (latest one per title), then finishes known only from the item.
  const diary = rows(19).filter((r) => inPeriod(r.logged_at));
  const seen = new Set<number>();
  const finished = diary.filter((r) => r.kind === "finished" && !seen.has(num(r.item_id)) && seen.add(num(r.item_id)))
    .map((r) => ({ ...r, rewatch: Boolean(r.rewatch) }));
  const finishedItems = rows(20)
    .filter((r) => !seen.has(num(r.id)) && inPeriod(str(r.completed_at) ?? str(r.last_watched_at)))
    .map((r) => ({
      item_id: num(r.id), type: r.type, title: r.title, author: r.author ?? null, image_url: r.image_url ?? null,
      cover_override_url: r.cover_override_url ?? null, rating: r.rating ?? null,
      finished_at: str(r.completed_at) ?? str(r.last_watched_at),
    }));
  const started = new Set(diary.filter((r) => r.kind === "started").map((r) => num(r.item_id))).size;
  const episodes = diary.filter((r) => r.kind === "progress" && r.episode != null && ["show", "anime"].includes(String(r.type))).length;

  // Reading.
  let saved = 0, read = 0, minutes = 0;
  const sites = new Map<string, number>();
  const readDays: Record<string, number> = {};
  for (const r of rows(15)) {
    if (inPeriod(r.created_at)) saved++;
    if (!inPeriod(r.read_at)) continue;
    read++;
    minutes += num(r.reading_minutes);
    const day = clock(String(r.read_at)).day;
    readDays[day] = (readDays[day] ?? 0) + 1;
    if (str(r.site)) sites.set(String(r.site), (sites.get(String(r.site)) ?? 0) + 1);
  }
  const marks = rows(16).filter((r) => inPeriod(r.created_at));
  // The line worth showing: one with a note of yours first, else one that reads as a sentence.
  const candidates = marks.filter((r) => { const n = String(r.text ?? "").length; return n >= 50 && n <= 260; });
  const pick = candidates.find((r) => str(r.note)) ?? candidates[0];
  const byDoc = new Map<string, Row[]>();
  for (const m of marks) byDoc.set(String(m.document_id), [...(byDoc.get(String(m.document_id)) ?? []), m]);
  const busiest = [...byDoc.values()].sort((a, b) => b.length - a.length)[0];

  // Writing and the journal.
  const posts = rows(17).filter((r) => inPeriod(str(r.published_at)?.length === 10 ? `${r.published_at}T00:00:00Z` : r.published_at))
    .map((r) => ({ title: str(r.title) ?? "Untitled", day: clock(String(r.published_at).length === 10 ? `${r.published_at}T12:00:00Z` : String(r.published_at)).day, words: words(r.content) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const docs = rows(18).filter((r) => inPeriod(r.created_at));
  const journalDays: Record<string, number> = {};
  let entries = 0, journalWords = 0;
  for (const r of journalRows) {
    const day = clock(r.at).day;
    if (!inDays(day)) continue;
    journalDays[day] = (journalDays[day] ?? 0) + r.words;
    entries++;
    journalWords += r.words;
  }

  return {
    from, to, tz, start, until,
    code: {
      seconds: Object.values(codeDaily).reduce((a, b) => a + b, 0),
      daily: codeDaily, languages: ranked(1), projects: ranked(2), editors: ranked(3), hours, weekdays,
    },
    github: { total: Object.values(githubDaily).reduce((a, b) => a + b, 0), daily: githubDaily },
    training: { sessions },
    movement: {
      activities, steps, walking_km: walkingKm, sleep,
      recovery: whoopRecoveries && recovery.recovery != null ? num(recovery.recovery) : null,
      resting_hr: whoopRecoveries && recovery.resting_hr != null ? num(recovery.resting_hr) : average(healthResting),
      hrv: whoopRecoveries && recovery.hrv != null ? num(recovery.hrv) : null,
    },
    places: { places, countries: [...countries].sort(), per_day: placesPerDay, trips: placeTrips },
    music: {
      plays: num(musicTotals.plays), minutes: num(musicTotals.ms) / 60_000, since: str(musicTotals.since),
      artists: rows(12).map((r) => ({ name: String(r.name), value: num(r.plays) })),
      tracks: rows(13).map((r) => ({ name: str(r.track) ?? "Unknown", detail: str(r.artist) ?? "Unknown", value: num(r.plays) })),
      per_day: musicPerDay, hours: musicHours,
    },
    library: { finished, finished_items: finishedItems, started, episodes },
    reading: {
      saved, read, minutes, sites: top([...sites].map(([name, value]) => ({ name, value }))), highlights: marks.length,
      quote: pick ? { text: String(pick.text).trim(), source: str(pick.title) ?? "" } : null,
      most_marked: busiest && busiest.length >= 2 ? { name: str(busiest[0].title) ?? "An article", value: busiest.length } : null,
      read_days: readDays,
    },
    writing: {
      posts,
      notes_started: docs.filter((r) => r.kind === "note").length,
      drafts_started: docs.filter((r) => r.kind === "writing").length,
    },
    journal: { days: journalDays, entries, words: journalWords },
  };
}
