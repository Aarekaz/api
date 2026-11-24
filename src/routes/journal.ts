import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { parseJson } from "../utils/json";
import { ulid } from "../services/documents-core";
import { createDocument, deleteDocument, DocumentError, getDocument, saveDocument, type DocumentRow } from "../services/documents";

// /v1/journal: your journal as a timeline of moments. Each entry is a locked
// `journal` document (so search, versions, sync and the nightly backup keep
// working), with when it happened, where you were, how you felt (a State of
// Mind: valence -1…1 plus labels), what it was about (attachments: photos,
// the workout, a song, a place, an article), where it came from (written
// here, a suggestion, an import) and the prompt it answered, all kept in its
// frontmatter. No new tables. Journal entries are never public and never
// shown to agents. Every field added since v1 is optional, so old clients
// keep working: `mood` (the five weather words) is still read and written,
// and is derived from `state_of_mind` when only that is sent.

const app = new Hono<{ Bindings: Env }>();

const Place = z.object({
  name: z.string().trim().min(1).max(200),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
});

const MOODS = ["great", "good", "okay", "low", "rough"] as const;
const Mood = z.enum(MOODS);
type MoodWord = z.infer<typeof Mood>;

/** Like HealthKit's HKStateOfMind: how pleasant (-1…1), which feelings, about what, a moment or the day. */
const StateOfMind = z.object({
  valence: z.number().min(-1).max(1),
  labels: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  associations: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  kind: z.enum(["momentary", "daily"]).default("momentary"),
  /** The Health sample written for it, so an edit can replace it (samples are immutable). */
  hk_uuid: z.string().trim().max(64).nullish(),
});

const ATTACHMENT_KINDS = ["photo", "workout", "place", "song", "article", "link", "note"] as const;
const MetaValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const Attachment = z.object({
  kind: z.enum(ATTACHMENT_KINDS),
  /** Photo: its R2 key (journal/…); workout: the day; song: the track id or URL; article/link: the URL. */
  ref: z.string().trim().min(1).max(1000),
  title: z.string().trim().max(300).nullish(),
  meta: z.record(MetaValue).optional(),
}).refine((a) => a.kind !== "photo" || PHOTO_KEY.test(a.ref), { message: "photo ref must be a key from POST /v1/journal/photos", path: ["ref"] });

const Source = z.enum(["native", "suggestion", "apple_import", "import"]);

const Fields = {
  body: z.string().max(200_000),
  happened_at: z.string().datetime({ offset: true }),
  place: Place.nullish(),
  mood: Mood.nullish(),
  state_of_mind: StateOfMind.nullish(),
  attachments: z.array(Attachment).max(24).nullish(),
  prompt: z.string().trim().max(500).nullish(),
};

const CreateEntry = z.object({
  ...Fields,
  happened_at: Fields.happened_at.optional(),
  source: Source.optional(),
  /** Its id where it came from (an Apple Journal export file, say): posting it twice returns the first. */
  external_id: z.string().trim().min(1).max(300).nullish(),
});

const UpdateEntry = z.object({
  version: z.number().int(),
  ...Fields,
  body: Fields.body.optional(),
  happened_at: Fields.happened_at.optional(),
});

type PlaceT = z.infer<typeof Place>;
type StateOfMindT = z.infer<typeof StateOfMind>;
type AttachmentT = z.infer<typeof Attachment>;
type SourceT = z.infer<typeof Source>;

export type JournalEntry = {
  id: string;
  body: string;
  happened_at: string;
  place: PlaceT | null;
  mood: MoodWord | null;
  state_of_mind: StateOfMindT | null;
  attachments: AttachmentT[];
  source: SourceT;
  external_id: string | null;
  prompt: string | null;
  words: number;
  created_at: string;
  updated_at: string;
  version: number;
};

type Meta = {
  happened_at?: string;
  place?: PlaceT | null;
  mood?: MoodWord | null;
  state_of_mind?: StateOfMindT | null;
  attachments?: AttachmentT[];
  source?: SourceT;
  external_id?: string | null;
  prompt?: string | null;
};

function meta(row: { frontmatter_json: string | null }): Meta {
  try { return row.frontmatter_json ? JSON.parse(row.frontmatter_json) as Meta : {}; } catch { return {}; }
}

/** The weather word for a valence: the five moods split -1…1 evenly. */
export function moodFor(valence: number): MoodWord {
  if (valence >= 0.6) return "great";
  if (valence >= 0.2) return "good";
  if (valence > -0.2) return "okay";
  if (valence > -0.6) return "low";
  return "rough";
}

/** Where each weather word sits on the valence line. */
export const MOOD_VALENCE: Record<MoodWord, number> = { great: 0.8, good: 0.4, okay: 0, low: -0.4, rough: -0.8 };

export function countWords(body: string): number {
  const words = body.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return words ? words.length : 0;
}

export function presentEntry(row: DocumentRow): JournalEntry {
  const m = meta(row);
  const mood = m.mood ?? (m.state_of_mind ? moodFor(m.state_of_mind.valence) : null);
  // Entries from before State of Mind still answer with one, placed by their mood.
  const state = m.state_of_mind ?? (mood ? { valence: MOOD_VALENCE[mood], labels: [], associations: [], kind: "momentary" as const, hk_uuid: null } : null);
  return {
    id: row.id, body: row.body, happened_at: m.happened_at ?? row.created_at, place: m.place ?? null,
    mood, state_of_mind: state, attachments: Array.isArray(m.attachments) ? m.attachments : [],
    source: m.source ?? "native", external_id: m.external_id ?? null, prompt: m.prompt ?? null,
    words: countWords(row.body),
    created_at: row.created_at, updated_at: row.updated_at, version: row.version,
  };
}

/**
 * Mood and State of Mind stay in step. Sending one sets the other; sending
 * only `mood` keeps the stored State of Mind when it already reads that way
 * (an old client re-saving an entry doesn't lose its labels).
 */
function feelings(
  input: { mood?: MoodWord | null; state_of_mind?: StateOfMindT | null },
  current: { mood?: MoodWord | null; state_of_mind?: StateOfMindT | null },
): { mood: MoodWord | null; state_of_mind: StateOfMindT | null } {
  if (input.state_of_mind) return { state_of_mind: input.state_of_mind, mood: input.mood ?? moodFor(input.state_of_mind.valence) };
  if (input.state_of_mind === null) return { state_of_mind: null, mood: input.mood ?? null };
  if (input.mood === undefined) return { mood: current.mood ?? null, state_of_mind: current.state_of_mind ?? null };
  if (input.mood === null) return { mood: null, state_of_mind: null };
  const kept = current.state_of_mind;
  if (kept && moodFor(kept.valence) === input.mood) return { mood: input.mood, state_of_mind: kept };
  return {
    mood: input.mood,
    state_of_mind: { valence: MOOD_VALENCE[input.mood], labels: [], associations: [], kind: "momentary", hk_uuid: kept?.hk_uuid ?? null },
  };
}

/** One error shape for new routes: { error: { code, message } }. */
function fail(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof z.ZodError) {
    return c.json({ error: { code: "invalid", message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
  }
  if (error instanceof DocumentError) {
    const code = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid";
    return c.json({ error: { code, message: error.message } }, error.status);
  }
  console.error("journal route failed", error);
  return c.json({ error: { code: "server", message: "Journal request failed" } }, 500);
}

const iso = (s: string) => new Date(s).toISOString();
const WHEN = "COALESCE(json_extract(frontmatter_json, '$.happened_at'), created_at)";
const LIVE = "kind = 'journal' AND deleted_at IS NULL";

// MARK: Days in your time zone

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A function from an instant to its local day ("2026-11-24"): IANA `tz`, else `offset` minutes, else UTC. */
export function dayIn(tz?: string, offset?: string): (at: string) => string {
  if (tz) {
    try {
      const format = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      return (at) => format.format(new Date(at));
    } catch { /* unknown zone: fall through */ }
  }
  const minutes = Number(offset);
  const shift = Number.isFinite(minutes) && Math.abs(minutes) <= 14 * 60 ? minutes * 60_000 : 0;
  return (at) => new Date(Date.parse(at) + shift).toISOString().slice(0, 10);
}

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
const dayFromNumber = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayFromNumber(dayNumber(day) + n);
/** Monday of the day's week, as a day number. */
const weekOf = (day: string) => { const n = dayNumber(day); return n - ((new Date(n * 86_400_000).getUTCDay() + 6) % 7); };

export type Streak = { days: number; weeks: number; longest_days: number; today: boolean };

/**
 * A streak that forgives: today not written yet doesn't break it (it counts
 * up to yesterday), and the weekly streak only asks for one entry a week.
 */
export function streakOf(days: Iterable<string>, today: string): Streak {
  const set = new Set(days);
  let current = 0;
  for (let d = set.has(today) ? today : addDays(today, -1); set.has(d); d = addDays(d, -1)) current++;
  const weeks = new Set([...set].map(weekOf));
  let weekly = 0;
  for (let w = weeks.has(weekOf(today)) ? weekOf(today) : weekOf(today) - 7; weeks.has(w); w -= 7) weekly++;
  let longest = 0, run = 0, previous = NaN;
  for (const n of [...set].map(dayNumber).sort((a, b) => a - b)) {
    run = n === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = n;
  }
  return { days: current, weeks: weekly, longest_days: longest, today: set.has(today) };
}

// MARK: Photos (private R2 objects, served only through this authenticated route)

const PHOTO_KEY = /^journal\/[0-9A-Za-z-]{20,80}\.(jpg|png|heic|webp)$/;
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp" };
const MAX_PHOTO = 15 * 1024 * 1024;

/** POST /v1/journal/photos (raw image body) → { ref }: put the ref in an entry's attachments. */
app.post("/photos", async (c) => {
  const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const ext = PHOTO_TYPES[type];
  if (!ext) return c.json({ error: { code: "invalid", message: "Send a JPEG, PNG, HEIC or WebP image" } }, 415);
  const length = Number(c.req.header("content-length"));
  if (length > MAX_PHOTO) return c.json({ error: { code: "too_large", message: "Photos can be up to 15 MB" } }, 413);
  const data = await c.req.arrayBuffer();
  if (!data.byteLength) return c.json({ error: { code: "invalid", message: "The image is empty" } }, 400);
  if (data.byteLength > MAX_PHOTO) return c.json({ error: { code: "too_large", message: "Photos can be up to 15 MB" } }, 413);
  // Unguessable, and never linked from anything public.
  const ref = `journal/${ulid()}-${crypto.randomUUID()}.${ext}`;
  await c.env.R2_BUCKET.put(ref, data, { httpMetadata: { contentType: type, cacheControl: "private, max-age=31536000, immutable" } });
  return c.json({ ref, content_type: type, size: data.byteLength }, 201);
});

/** GET /v1/journal/photos/:name: the image, for the signed-in app only. */
app.get("/photos/:name", async (c) => {
  const ref = `journal/${c.req.param("name")}`;
  if (!PHOTO_KEY.test(ref)) return c.json({ error: { code: "not_found", message: "No such photo" } }, 404);
  const object = await c.env.R2_BUCKET.get(ref);
  if (!object) return c.json({ error: { code: "not_found", message: "No such photo" } }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});

// MARK: Stats and on this day

/**
 * GET /v1/journal/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Area/City&today=YYYY-MM-DD
 * Entries and words per local day (only days you wrote), totals for the range,
 * and the streak over all time. Defaults to the last 365 days.
 */
app.get("/stats", async (c) => {
  try {
    const local = dayIn(c.req.query("tz"), c.req.query("offset"));
    const todayQ = c.req.query("today");
    const today = todayQ && DAY.test(todayQ) ? todayQ : local(new Date().toISOString());
    const toQ = c.req.query("to"), fromQ = c.req.query("from");
    const to = toQ && DAY.test(toQ) ? toQ : today;
    const from = fromQ && DAY.test(fromQ) ? fromQ : addDays(to, -364);
    // Pad by a day each side for time zones; the exact cut is made on local days.
    const { results } = await c.env.DB.prepare(
      `SELECT ${WHEN} AS at, body FROM documents WHERE ${LIVE} AND ${WHEN} >= ? AND ${WHEN} < ?`,
    ).bind(`${addDays(from, -1)}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`).all<{ at: string; body: string }>();
    const perDay = new Map<string, { entries: number; words: number }>();
    for (const r of results) {
      const day = local(r.at);
      if (day < from || day > to) continue;
      const d = perDay.get(day) ?? { entries: 0, words: 0 };
      d.entries++; d.words += countWords(r.body);
      perDay.set(day, d);
    }
    const days = [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, ...d }));

    const all = await c.env.DB.prepare(`SELECT ${WHEN} AS at FROM documents WHERE ${LIVE}`).all<{ at: string }>();
    const allDays = all.results.map((r) => local(r.at));
    return c.json({
      from, to, today,
      days,
      totals: { entries: days.reduce((n, d) => n + d.entries, 0), words: days.reduce((n, d) => n + d.words, 0), days: days.length },
      all_time: { entries: allDays.length, days: new Set(allDays).size, first_day: allDays.length ? allDays.reduce((a, b) => (a < b ? a : b)) : null },
      streak: streakOf(allDays, today),
    });
  } catch (error) {
    return fail(c, error);
  }
});

/** GET /v1/journal/on-this-day?date=YYYY-MM-DD&tz= : entries from earlier years on this month and day, newest first. */
app.get("/on-this-day", async (c) => {
  try {
    const local = dayIn(c.req.query("tz"), c.req.query("offset"));
    const dateQ = c.req.query("date");
    const date = dateQ && DAY.test(dateQ) ? dateQ : local(new Date().toISOString());
    const md = date.slice(5);
    // The UTC month-day can be a day either side of the local one.
    const near = [addDays(date, -1), date, addDays(date, 1)].map((d) => d.slice(5));
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM documents WHERE ${LIVE} AND substr(${WHEN}, 6, 5) IN (?, ?, ?) AND ${WHEN} < ? ORDER BY ${WHEN} DESC LIMIT 200`,
    ).bind(...near, `${date.slice(0, 4)}-01-02`).all<DocumentRow>();
    const year = Number(date.slice(0, 4));
    const items = results.map(presentEntry)
      .map((e) => ({ ...e, day: local(e.happened_at) }))
      .filter((e) => e.day.slice(5) === md && Number(e.day.slice(0, 4)) < year)
      .map((e) => ({ ...e, years_ago: year - Number(e.day.slice(0, 4)) }));
    return c.json({ date, items });
  } catch (error) {
    return fail(c, error);
  }
});

// MARK: Entries

/** GET /v1/journal?from=&to=&q=&limit= : entries, newest first, by when they happened. `q` matches the words. */
app.get("/", async (c) => {
  try {
    const from = c.req.query("from"), to = c.req.query("to"), q = c.req.query("q")?.trim();
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 500, 1), 2000);
    const where = [LIVE];
    const args: unknown[] = [];
    if (from && !Number.isNaN(Date.parse(from))) { where.push(`${WHEN} >= ?`); args.push(iso(from)); }
    if (to && !Number.isNaN(Date.parse(to))) { where.push(`${WHEN} < ?`); args.push(iso(to)); }
    if (q) {
      // Every word has to appear, in the text, the place or the prompt.
      for (const word of q.split(/\s+/).slice(0, 8)) {
        const like = `%${word.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        where.push(`(body LIKE ? ESCAPE '\\' OR json_extract(frontmatter_json, '$.place.name') LIKE ? ESCAPE '\\' OR json_extract(frontmatter_json, '$.prompt') LIKE ? ESCAPE '\\')`);
        args.push(like, like, like);
      }
    }
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM documents WHERE ${where.join(" AND ")} ORDER BY ${WHEN} DESC LIMIT ?`,
    ).bind(...args, limit).all<DocumentRow>();
    return c.json({ items: results.map(presentEntry) });
  } catch (error) {
    return fail(c, error);
  }
});

/** GET /v1/journal/:id */
app.get("/:id", async (c) => {
  try {
    const row = await getDocument(c.env, c.req.param("id"));
    if (row.kind !== "journal") throw new DocumentError("Not a journal entry", 404);
    return c.json(presentEntry(row));
  } catch (error) {
    return fail(c, error);
  }
});

/** POST /v1/journal { body, happened_at?, place?, mood? | state_of_mind?, attachments?, prompt?, source?, external_id? } */
app.post("/", async (c) => {
  try {
    const input = CreateEntry.parse(await parseJson(c.req.raw));
    const source = input.source ?? "native";
    if (input.external_id) {
      const existing = await c.env.DB.prepare(
        `SELECT * FROM documents WHERE ${LIVE} AND json_extract(frontmatter_json, '$.external_id') = ? AND json_extract(frontmatter_json, '$.source') = ? LIMIT 1`,
      ).bind(input.external_id, source).first<DocumentRow>();
      if (existing) return c.json(presentEntry(existing), 200);
    }
    const happened = input.happened_at ? iso(input.happened_at) : new Date().toISOString();
    const frontmatter: Meta = {
      happened_at: happened, place: input.place ?? null, ...feelings(input, {}),
      attachments: input.attachments ?? [], source, external_id: input.external_id ?? null, prompt: input.prompt ?? null,
    };
    const row = await createDocument(c.env, {
      kind: "journal", title: happened.slice(0, 16).replace("T", " "), body: input.body, folder: "Journal", frontmatter,
    });
    return c.json(presentEntry(row), 201);
  } catch (error) {
    return fail(c, error);
  }
});

/** PATCH /v1/journal/:id { version, body?, happened_at?, place?, mood? | state_of_mind?, attachments?, prompt? } */
app.patch("/:id", async (c) => {
  try {
    const input = UpdateEntry.parse(await parseJson(c.req.raw));
    const current = await getDocument(c.env, c.req.param("id"));
    if (current.kind !== "journal") throw new DocumentError("Not a journal entry", 404);
    const m = meta(current);
    const keep = <T>(next: T | undefined, now: T) => (next === undefined ? now : next);
    const next: Meta = {
      ...m,
      happened_at: input.happened_at ? iso(input.happened_at) : m.happened_at ?? current.created_at,
      place: keep(input.place, m.place ?? null),
      ...feelings(input, m),
      attachments: keep(input.attachments, m.attachments ?? []) ?? [],
      prompt: keep(input.prompt, m.prompt ?? null),
    };
    const row = await saveDocument(c.env, current.id, {
      version: input.version, body: input.body, frontmatter: next,
      title: next.happened_at!.slice(0, 16).replace("T", " "),
    });
    return c.json(presentEntry(row));
  } catch (error) {
    return fail(c, error);
  }
});

/** DELETE /v1/journal/:id (soft: it can come back; its photos are kept) */
app.delete("/:id", async (c) => {
  try {
    const current = await getDocument(c.env, c.req.param("id"));
    if (current.kind !== "journal") throw new DocumentError("Not a journal entry", 404);
    await deleteDocument(c.env, current.id);
    return c.json({ ok: true });
  } catch (error) {
    return fail(c, error);
  }
});

export default app;
