import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { body, cursorFrom, appErrors, fail, later, limitFrom, list, page } from "../lib/http";
import { photoResponse, receivePhoto } from "../lib/private-photos";
import {
  authSecurity,
  cursorQuery,
  pageFields,
  dateSchema,
  imageUploadSchema,
  okSchema,
  openApiJsonRequestBody,
  apiTags,
  openApiRegistry,
  openApiResponse,
  structuredCreatedResponses,
  structuredErrorResponses,
  structuredErrorSchema,
  structuredOkResponses,
} from "../schemas/openapi";
import { createDocument, deleteDocument, DocumentError, getDocument, saveDocument, type DocumentRow } from "../services/documents";
import { DAY, dayAtOffset, dayInZone, shiftDay } from "../utils/date";
import { JOURNAL_WHEN, countWords, recordWords, wordsBetween } from "../services/journal-words";

export { countWords };

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

const app = appErrors(new Hono<{ Bindings: Env }>(), "Journal request");

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

// Request fields. Place, StateOfMind, Attachment and Source are also in the
// response (entrySchema), so their descriptions go on the field here, not on them.
const Fields = {
  body: z.string().max(200_000).openapi({ description: "What you wrote, as plain text or Markdown" }),
  happened_at: z.string().datetime({ offset: true }).openapi({
    description: "When the moment happened, ISO time with offset. Defaults to now on create",
  }),
  place: Place.nullish().openapi({ description: "Where you were: { name, lat?, lng? }. null clears it" }),
  mood: Mood.nullish().openapi({
    description: "The five weather words. Sending only mood sets a matching state_of_mind; send one or the other",
  }),
  state_of_mind: StateOfMind.nullish().openapi({
    description: "How it felt, like Health's State of Mind: valence -1 (very unpleasant) to 1 (very pleasant), labels "
      + "(feelings), associations (what it was about), kind momentary or daily. mood is worked out from it",
  }),
  attachments: z.array(Attachment).max(24).nullish().openapi({
    description: "What it is about, up to 24: { kind, ref, title?, meta? }. kind photo (ref from POST /v1/journal/photos), "
      + "workout (ref: the day), place, song (track id or URL), article or link (the URL), note",
  }),
  prompt: z.string().trim().max(500).nullish().openapi({ description: "The question the entry answers, when it came from one" }),
};

const CreateEntry = z.object({
  ...Fields,
  happened_at: Fields.happened_at.optional(),
  source: Source.optional().openapi({
    description: "Where it came from: native (written in the app, the default), suggestion, apple_import or import",
  }),
  /** Its id where it came from (an Apple Journal export file, say): posting it twice returns the first. */
  external_id: z.string().trim().min(1).max(300).nullish().openapi({
    description: "Its id where it came from, for imports: posting the same source and external_id again returns the first entry",
  }),
});

const UpdateEntry = z.object({
  version: z.number().int().openapi({ description: "The version you loaded; a stale one is a 409" }),
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

/** One error shape, { error: { code, message } } (lib/http.ts). */

/** Stores a written entry's word count for /stats, after the reply where the runtime allows. */
async function countLater(c: Parameters<typeof later>[0], row: DocumentRow) {
  const work = recordWords(c.env as Env, row);
  const after = later(c);
  if (after) after(work); else await work;
}

const iso = (s: string) => new Date(s).toISOString();
// Migration 0055 indexes this exact expression for live entries (LIVE).
const WHEN = JOURNAL_WHEN;
const LIVE = "kind = 'journal' AND deleted_at IS NULL";

// MARK: Days in your time zone

/** A function from an instant to its local day ("2026-11-24"): IANA `tz`, else `offset` minutes, else UTC. */
export function dayIn(tz?: string, offset?: string): (at: string) => string {
  if (tz) {
    try {
      return dayInZone(tz);
    } catch { /* unknown zone: fall through */ }
  }
  const minutes = Number(offset);
  const shift = Number.isFinite(minutes) && Math.abs(minutes) <= 14 * 60 ? minutes : 0;
  return (at) => dayAtOffset(at, shift);
}

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
const addDays = shiftDay;
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

/** POST /v1/journal/photos (raw image body) → { ref }: put the ref in an entry's attachments. */
app.post("/photos", async (c) => {
  // Unguessable, and kept in the private bucket, which has no public address.
  const stored = await receivePhoto(c, "journal", c.env.R2_PRIVATE ?? c.env.R2_BUCKET);
  if (stored instanceof Response) return stored;
  return c.json({ ref: stored.ref, content_type: stored.content_type, size: stored.size }, 201);
});

/** GET /v1/journal/photos/:name: the image, for the signed-in app only. */
app.get("/photos/:name", async (c) => {
  const ref = `journal/${c.req.param("name")}`;
  if (!PHOTO_KEY.test(ref)) return fail(c, 404, "No such photo");
  // Older photos were saved in the public bucket before the private one existed.
  const object = (await c.env.R2_PRIVATE?.get(ref)) ?? (await c.env.R2_BUCKET.get(ref));
  if (!object) return fail(c, 404, "No such photo");
  return photoResponse(object);
});

// MARK: Stats and on this day

/**
 * GET /v1/journal/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Area/City&today=YYYY-MM-DD
 * Entries and words per local day (only days you wrote), totals for the range,
 * and the streak over all time. Defaults to the last 365 days.
 */
app.get("/stats", async (c) => {
  const local = dayIn(c.req.query("tz"), c.req.query("offset"));
  const todayQ = c.req.query("today");
  const today = todayQ && DAY.test(todayQ) ? todayQ : local(new Date().toISOString());
  const toQ = c.req.query("to"), fromQ = c.req.query("from");
  const to = toQ && DAY.test(toQ) ? toQ : today;
  const from = fromQ && DAY.test(fromQ) ? fromQ : addDays(to, -364);
  // Pad by a day each side for time zones; the exact cut is made on local days.
  const results = await wordsBetween(c.env, WHEN, `${addDays(from, -1)}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`);
  const perDay = new Map<string, { entries: number; words: number }>();
  for (const r of results) {
    const day = local(r.at);
    if (day < from || day > to) continue;
    const d = perDay.get(day) ?? { entries: 0, words: 0 };
    d.entries++; d.words += r.words;
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
});

/** GET /v1/journal/on-this-day?date=YYYY-MM-DD&tz= : entries from earlier years on this month and day, newest first. */
app.get("/on-this-day", async (c) => {
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
});

// MARK: Entries

/** GET /v1/journal?from=&to=&q=&limit= : entries, newest first, by when they happened. `q` matches the words. */
app.get("/", async (c) => {
  const from = c.req.query("from"), to = c.req.query("to"), q = c.req.query("q")?.trim();
  const limit = limitFrom(c, 500, 2000);
  const after = cursorFrom(c, 2);
  const where = [LIVE];
  const args: unknown[] = [];
  // The leading `<=` repeats what the OR implies, so the index can seek.
  if (after) { where.push(`${WHEN} <= ?`, `(${WHEN} < ? OR (${WHEN} = ? AND id < ?))`); args.push(after[0], after[0], after[0], after[1]); }
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
    `SELECT *, ${WHEN} AS sort_at FROM documents WHERE ${where.join(" AND ")} ORDER BY ${WHEN} DESC, id DESC LIMIT ?`,
  ).bind(...args, limit + 1).all<DocumentRow & { sort_at: string }>();
  const { items, next_cursor } = page(results, limit, (row) => [row.sort_at, row.id]);
  return list(c, items.map(presentEntry), next_cursor);
});

/** GET /v1/journal/:id */
app.get("/:id", async (c) => {
  const row = await getDocument(c.env, c.req.param("id"));
  if (row.kind !== "journal") throw new DocumentError("Not a journal entry", 404);
  return c.json(presentEntry(row));
});

/** POST /v1/journal { body, happened_at?, place?, mood? | state_of_mind?, attachments?, prompt?, source?, external_id? } */
app.post("/", async (c) => {
  const input = await body(c, CreateEntry);
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
  await countLater(c, row);
  return c.json(presentEntry(row), 201);
});

/** PATCH /v1/journal/:id { version, body?, happened_at?, place?, mood? | state_of_mind?, attachments?, prompt? } */
app.patch("/:id", async (c) => {
  const input = await body(c, UpdateEntry);
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
  await countLater(c, row);
  return c.json(presentEntry(row));
});

/** DELETE /v1/journal/:id (soft: it can come back; its photos are kept) */
app.delete("/:id", async (c) => {
  const current = await getDocument(c.env, c.req.param("id"));
  if (current.kind !== "journal") throw new DocumentError("Not a journal entry", 404);
  await deleteDocument(c.env, current.id);
  return c.json({ ok: true });
});

// MARK: OpenAPI

const TAG = "Journal";
apiTags.push({
  name: TAG,
  description: `The owner's journal: a timeline of moments, each with when it happened, where, how it felt and what it was about. \
Private: nothing here is shown on anuragd.me. Every entry is \`locked\`: the journal is not for agents.

**Don't read or write the journal unless the owner asks you to.** Don't quote it anywhere else.

**Order.** For an import, set \`source\` (import, apple_import) and \`external_id\`: posting the same pair again returns \
the first entry (200), so a retried import makes no copies. Upload photos first (below), then POST /v1/journal with their refs \
in \`attachments\`. PATCH /v1/journal/{id} needs the \`version\` you loaded; fields left out keep their value. \
DELETE is soft and keeps the photos.

**Photos.** POST /v1/journal/photos with the raw bytes as the body and its Content-Type (image/jpeg, image/png, \
image/heic or image/webp; up to 15 MB). They go to the private bucket (R2_PRIVATE) and are read back only through \
GET /v1/journal/photos/{name}. Put the returned \`ref\` (journal/…) in \`attachments\` as { kind: "photo", ref }.

**Feelings.** Send \`state_of_mind\` (or only \`mood\`); the other is kept in step.`,
});

const entrySchema = z.object({
  id: z.string(),
  body: z.string(),
  happened_at: z.string(),
  place: Place.nullable(),
  mood: Mood.nullable(),
  state_of_mind: StateOfMind.nullable(),
  attachments: z.array(Attachment),
  source: Source,
  external_id: z.string().nullable(),
  prompt: z.string().nullable(),
  words: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number().int(),
});
const entryParams = z.object({ id: z.string() });
const zone = {
  tz: z.string().optional().openapi({ description: "IANA time zone for local days, e.g. America/New_York" }),
  offset: z.coerce.number().int().optional().openapi({ description: "Minutes from UTC, used when tz is absent" }),
};
const conflict = { 409: openApiResponse(structuredErrorSchema, "The entry changed since you loaded it") };

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/journal/photos",
  tags: [TAG],
  summary: "Upload a private journal photo (up to 15 MB)",
  description: "Put the returned ref in an entry's attachments as { kind: \"photo\", ref }.",
  security: authSecurity,
  request: {
    body: {
      description: "JPEG, PNG, HEIC or WebP image",
      content: { "image/*": { schema: imageUploadSchema } },
    },
  },
  responses: {
    201: openApiResponse(z.object({ ref: z.string(), content_type: z.string(), size: z.number().int() }), "Created"),
    ...structuredErrorResponses,
    413: openApiResponse(structuredErrorSchema, "Photo too large"),
    415: openApiResponse(structuredErrorSchema, "Unsupported image type"),
  },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/journal/photos/{name}",
  tags: [TAG],
  summary: "Get a journal photo",
  security: authSecurity,
  request: { params: z.object({ name: z.string().openapi({ description: "The ref without its journal/ prefix" }) }) },
  responses: {
    200: { description: "The image", content: { "image/*": { schema: imageUploadSchema } } },
    ...structuredErrorResponses,
  },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/journal/stats",
  tags: [TAG],
  summary: "Get entries and words per local day, totals and streaks",
  description: "Defaults to the 365 days up to today. Only days you wrote are listed.",
  security: authSecurity,
  request: {
    query: z.object({
      from: dateSchema.optional(),
      to: dateSchema.optional(),
      today: dateSchema.optional(),
      ...zone,
    }),
  },
  responses: structuredOkResponses(z.object({
    from: dateSchema,
    to: dateSchema,
    today: dateSchema,
    days: z.array(z.object({ day: dateSchema, entries: z.number().int(), words: z.number().int() })),
    totals: z.object({ entries: z.number().int(), words: z.number().int(), days: z.number().int() }),
    all_time: z.object({ entries: z.number().int(), days: z.number().int(), first_day: dateSchema.nullable() }),
    streak: z.object({
      days: z.number().int(),
      weeks: z.number().int(),
      longest_days: z.number().int(),
      today: z.boolean(),
    }),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/journal/on-this-day",
  tags: [TAG],
  summary: "List entries from earlier years on this month and day",
  security: authSecurity,
  request: { query: z.object({ date: dateSchema.optional(), ...zone }) },
  responses: structuredOkResponses(z.object({
    date: dateSchema,
    items: z.array(entrySchema.extend({ day: dateSchema, years_ago: z.number().int() })),
  })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/journal",
  tags: [TAG],
  summary: "List journal entries, newest first by when they happened",
  security: authSecurity,
  request: {
    query: z.object({
      from: z.string().optional().openapi({ description: "ISO time" }),
      to: z.string().optional().openapi({ description: "ISO time" }),
      q: z.string().optional().openapi({ description: "Every word must appear in the text, place or prompt" }),
      limit: z.coerce.number().int().min(1).max(2000).optional().openapi({ description: "Default 500" }),
      cursor: cursorQuery,
    }),
  },
  responses: structuredOkResponses(z.object(pageFields(entrySchema))),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/journal/{id}",
  tags: [TAG],
  summary: "Get journal entry",
  security: authSecurity,
  request: { params: entryParams },
  responses: structuredOkResponses(entrySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/journal",
  tags: [TAG],
  summary: "Create journal entry",
  description: "Posting the same source and external_id again returns the first entry with 200.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(CreateEntry) },
  responses: {
    ...structuredCreatedResponses(entrySchema),
    200: openApiResponse(entrySchema, "Already imported (same source and external_id)"),
  },
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/journal/{id}",
  tags: [TAG],
  summary: "Update journal entry",
  description: "Send the version you loaded. Fields left out keep their value.",
  security: authSecurity,
  request: { params: entryParams, body: openApiJsonRequestBody(UpdateEntry) },
  responses: { ...structuredOkResponses(entrySchema), ...conflict },
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/journal/{id}",
  tags: [TAG],
  summary: "Delete journal entry (soft; its photos are kept)",
  security: authSecurity,
  request: { params: entryParams },
  responses: structuredOkResponses(okSchema),
});

export default app;
