import { z } from "zod";

export interface Env {
  DB: D1Database;
  API_TOKEN: string;
  LANYARD_USER_ID: string;
  WAKATIME_API_KEY: string;
  WAKATIME_TIMEZONE: string;
}

type JsonRecord = Record<string, unknown>;

type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

const dateString = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Invalid date",
});

const profileSchema = z.object({
  name: z.string().min(1).optional(),
  bio: z.string().optional(),
  handles: z.record(z.unknown()).optional(),
  contact: z.record(z.unknown()).optional(),
  timezone: z.string().optional(),
  avatar_url: z.string().url().optional(),
  location: z.string().optional(),
});

const nowSchema = z.object({
  focus: z.string().optional(),
  status: z.string().optional(),
  availability: z.string().optional(),
  mood: z.string().optional(),
  current_song: z.string().optional(),
});

const settingsSchema = z.object({
  public_fields: z.array(z.string()).optional(),
  theme: z.string().optional(),
  flags: z.record(z.unknown()).optional(),
});

const projectSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  links: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
});

const noteSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const eventSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  occurred_at: dateString.optional(),
});

const postSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  published_at: dateString.optional(),
  pinned: z.boolean().optional(),
});

const usesItemSchema = z.object({
  category: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url().optional(),
  note: z.string().optional(),
});

const shelfItemSchema = z.object({
  type: z.string().min(1),
  title: z.string().optional(),
  quote: z.string().optional(),
  author: z.string().optional(),
  source: z.string().optional(),
  url: z.string().url().optional(),
  note: z.string().optional(),
  image_url: z.string().url().optional(),
  drawer: z.string().optional(),
  tags: z.array(z.string()).optional(),
  date_added: dateString.optional(),
});

const experienceSchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  location: z.string().optional(),
  start_date: dateString.optional(),
  end_date: dateString.optional(),
  employment_type: z.string().optional(),
  description: z.string().optional(),
});

const educationSchema = z.object({
  institution: z.string().min(1),
  degree: z.string().optional(),
  field: z.string().optional(),
  start_date: dateString.optional(),
  end_date: dateString.optional(),
  description: z.string().optional(),
});

const skillSchema = z.object({
  category: z.string().min(1),
  items: z.array(z.string()).optional(),
});

const photoSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  url: z.string().url(),
  thumb_url: z.string().url().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  shot_at: dateString.optional(),
  camera: z.string().optional(),
  lens: z.string().optional(),
  settings: z.string().optional(),
  location: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

function jsonResponse(data: JsonRecord | JsonRecord[], status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(message: string, status: number, details?: unknown): Response {
  if (details) {
    return jsonResponse({ error: message, details }, status);
  }
  return jsonResponse({ error: message }, status);
}

async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  if (!env.API_TOKEN) {
    return errorResponse("API token not configured", 500);
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return errorResponse("Missing authorization header", 401);
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || token !== env.API_TOKEN) {
    return errorResponse("Invalid token", 403);
  }

  return null;
}

async function parseJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validateBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown
): ValidationResult<z.infer<T>> {
  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      response: errorResponse("Validation error", 400, result.error.flatten()),
    };
  }

  return { ok: true, data: result.data };
}

function nowIso(): string {
  return new Date().toISOString();
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function hourInTimezone(timestampMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestampMs));
  const hourPart = parts.find((part) => part.type === "hour");
  return hourPart ? Number(hourPart.value) : new Date(timestampMs).getUTCHours();
}

function mapJsonField(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

function parseStoredJson(value: unknown): unknown | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeProfile(row: JsonRecord): JsonRecord {
  const { handles_json, contact_json, ...rest } = row;
  return {
    ...rest,
    handles: parseStoredJson(handles_json),
    contact: parseStoredJson(contact_json),
  };
}

function normalizeSettings(row: JsonRecord): JsonRecord {
  const { public_fields_json, flags_json, ...rest } = row;
  return {
    ...rest,
    public_fields: parseStoredJson(public_fields_json),
    flags: parseStoredJson(flags_json),
  };
}

function normalizeProject(row: JsonRecord): JsonRecord {
  const { links_json, tags_json, ...rest } = row;
  return {
    ...rest,
    links: parseStoredJson(links_json),
    tags: parseStoredJson(tags_json),
  };
}

function normalizeNote(row: JsonRecord): JsonRecord {
  const { tags_json, ...rest } = row;
  return {
    ...rest,
    tags: parseStoredJson(tags_json),
  };
}

function normalizeEvent(row: JsonRecord): JsonRecord {
  const { payload_json, ...rest } = row;
  return {
    ...rest,
    payload: parseStoredJson(payload_json),
  };
}

function normalizePost(row: JsonRecord): JsonRecord {
  const { tags_json, pinned, ...rest } = row;
  return {
    ...rest,
    tags: parseStoredJson(tags_json),
    pinned: Boolean(pinned),
  };
}

function normalizeShelfItem(row: JsonRecord): JsonRecord {
  const { tags_json, ...rest } = row;
  return {
    ...rest,
    tags: parseStoredJson(tags_json),
  };
}

function normalizeSkill(row: JsonRecord): JsonRecord {
  const { items_json, ...rest } = row;
  return {
    ...rest,
    items: parseStoredJson(items_json),
  };
}

function normalizePhoto(row: JsonRecord): JsonRecord {
  const { tags_json, ...rest } = row;
  return {
    ...rest,
    tags: parseStoredJson(tags_json),
  };
}

function normalizeStatusSnapshot(row: JsonRecord): JsonRecord {
  const { activity_json, spotify_json, payload_json, ...rest } = row;
  return {
    ...rest,
    activity: parseStoredJson(activity_json),
    spotify: parseStoredJson(spotify_json),
    payload: parseStoredJson(payload_json),
  };
}

function normalizeWakaTimeHourly(row: JsonRecord): JsonRecord {
  const { languages_json, ...rest } = row;
  return {
    ...rest,
    languages: parseStoredJson(languages_json) ?? {},
  };
}

async function shouldRefresh(
  env: Env,
  type: string,
  minMinutes: number
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT last_run_at FROM wakatime_refresh_log WHERE type = ?"
  )
    .bind(type)
    .all();

  const lastRun =
    row.results && row.results[0]
      ? String((row.results[0] as JsonRecord).last_run_at)
      : null;

  if (!lastRun) {
    return true;
  }

  const last = Date.parse(lastRun);
  if (Number.isNaN(last)) {
    return true;
  }

  const diffMinutes = (Date.now() - last) / 60000;
  return diffMinutes >= minMinutes;
}

async function markRefreshed(env: Env, type: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO wakatime_refresh_log (type, last_run_at)
     VALUES (?, ?)
     ON CONFLICT(type) DO UPDATE SET last_run_at = excluded.last_run_at`
  )
    .bind(type, now)
    .run();
}

async function refreshWakaTime(
  env: Env,
  start: string,
  end: string
): Promise<void> {
  if (!env.WAKATIME_API_KEY) {
    throw new Error("WAKATIME_API_KEY not configured");
  }

  const authHeader = `Basic ${btoa(env.WAKATIME_API_KEY)}`;
  const url = new URL("https://wakatime.com/api/v1/users/current/summaries");
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);

  const response = await fetch(url.toString(), {
    headers: {
      authorization: authHeader,
      "content-type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`WakaTime request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{
      range?: { date?: string; timezone?: string };
      grand_total?: { total_seconds?: number };
      languages?: Array<{ name?: string; total_seconds?: number; percent?: number }>;
      projects?: Array<{ name?: string; total_seconds?: number; percent?: number }>;
      editors?: Array<{ name?: string; total_seconds?: number; percent?: number }>;
    }>;
  };

  const days = payload.data ?? [];
  for (const day of days) {
    const date = day.range?.date;
    if (!date) {
      continue;
    }

    const totalSeconds = day.grand_total?.total_seconds ?? 0;
    const totalMinutes = Math.round(totalSeconds / 60);
    const timezone = day.range?.timezone ?? null;
    const createdAt = nowIso();

    await env.DB.prepare(
      `INSERT INTO wakatime_days (date, total_seconds, total_minutes, timezone, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         total_seconds = excluded.total_seconds,
         total_minutes = excluded.total_minutes,
         timezone = excluded.timezone,
         created_at = excluded.created_at`
    )
      .bind(date, totalSeconds, totalMinutes, timezone, createdAt)
      .run();

    const languages = day.languages ?? [];
    for (const item of languages) {
      if (!item.name) {
        continue;
      }
      const seconds = item.total_seconds ?? 0;
      const minutes = Math.round(seconds / 60);
      await env.DB.prepare(
        `INSERT INTO wakatime_languages (date, name, total_seconds, total_minutes, percent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, name) DO UPDATE SET
           total_seconds = excluded.total_seconds,
           total_minutes = excluded.total_minutes,
           percent = excluded.percent`
      )
        .bind(date, item.name, seconds, minutes, item.percent ?? null)
        .run();
    }

    const projects = day.projects ?? [];
    for (const item of projects) {
      if (!item.name) {
        continue;
      }
      const seconds = item.total_seconds ?? 0;
      const minutes = Math.round(seconds / 60);
      await env.DB.prepare(
        `INSERT INTO wakatime_projects (date, name, total_seconds, total_minutes, percent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, name) DO UPDATE SET
           total_seconds = excluded.total_seconds,
           total_minutes = excluded.total_minutes,
           percent = excluded.percent`
      )
        .bind(date, item.name, seconds, minutes, item.percent ?? null)
        .run();
    }

    const editors = day.editors ?? [];
    for (const item of editors) {
      if (!item.name) {
        continue;
      }
      const seconds = item.total_seconds ?? 0;
      const minutes = Math.round(seconds / 60);
      await env.DB.prepare(
        `INSERT INTO wakatime_editors (date, name, total_seconds, total_minutes, percent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, name) DO UPDATE SET
           total_seconds = excluded.total_seconds,
           total_minutes = excluded.total_minutes,
           percent = excluded.percent`
      )
        .bind(date, item.name, seconds, minutes, item.percent ?? null)
        .run();
    }
  }
}

async function refreshWakaTimeHourly(
  env: Env,
  start: string,
  end: string
): Promise<void> {
  if (!env.WAKATIME_API_KEY) {
    throw new Error("WAKATIME_API_KEY not configured");
  }

  const authHeader = `Basic ${btoa(env.WAKATIME_API_KEY)}`;
  const timezone = env.WAKATIME_TIMEZONE || "UTC";
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);

  for (
    let cursor = new Date(startDate);
    cursor <= endDate;
    cursor = addDays(cursor, 1)
  ) {
    const dateStr = dateOnly(cursor);
    const response = await fetch(
      `https://wakatime.com/api/v1/users/current/durations?date=${dateStr}`,
      {
        headers: {
          authorization: authHeader,
        },
      }
    );

    if (!response.ok) {
      continue;
    }

    const payload = (await response.json()) as {
      data?: Array<{
        time?: number;
        duration?: number;
        language?: string;
        languages?: Array<{ name?: string }>;
      }>;
    };

    const items = Array.isArray(payload.data) ? payload.data : [];
    const perHour: Array<{
      seconds: number;
      languages: Record<string, number>;
    }> = Array.from({ length: 24 }, () => ({ seconds: 0, languages: {} }));

    for (const item of items) {
      const timestamp = (item.time ?? 0) * 1000;
      const hour = hourInTimezone(timestamp, timezone);
      const duration = item.duration ?? 0;
      if (hour < 0 || hour > 23) {
        continue;
      }
      perHour[hour].seconds += duration;

      const language = item.language ?? item.languages?.[0]?.name;
      if (language) {
        perHour[hour].languages[language] =
          (perHour[hour].languages[language] ?? 0) + duration;
      }
    }

    await env.DB.prepare("DELETE FROM wakatime_hourly WHERE date = ?")
      .bind(dateStr)
      .run();

    for (let hour = 0; hour < 24; hour += 1) {
      await env.DB.prepare(
        `INSERT INTO wakatime_hourly (date, hour, seconds, languages_json)
         VALUES (?, ?, ?, ?)`
      )
        .bind(
          dateStr,
          hour,
          Math.round(perHour[hour].seconds),
          mapJsonField(perHour[hour].languages)
        )
        .run();
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/health") {
      return jsonResponse({ status: "ok", timestamp: nowIso() });
    }

    if (pathname === "/") {
      return jsonResponse({
        title: "Personal API",
        author: "Anurag Dhungana",
        version: "v1",
        status: "ok",
        timestamp: nowIso(),
      });
    }

    if (pathname.startsWith("/v1")) {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }
    }

    if (pathname === "/v1/profile") {
      if (request.method === "GET") {
        const row = await env.DB.prepare("SELECT * FROM profile WHERE id = 1").all();
        return jsonResponse(
          row.results[0] ? normalizeProfile(row.results[0] as JsonRecord) : {}
        );
      }

      if (request.method === "PUT") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(profileSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const updatedAt = nowIso();
        await env.DB.prepare(
          `INSERT INTO profile (id, name, bio, handles_json, contact_json, timezone, avatar_url, location, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             bio = excluded.bio,
             handles_json = excluded.handles_json,
             contact_json = excluded.contact_json,
             timezone = excluded.timezone,
             avatar_url = excluded.avatar_url,
             location = excluded.location,
             updated_at = excluded.updated_at`
        )
          .bind(
            validation.data.name ?? null,
            validation.data.bio ?? null,
            mapJsonField(validation.data.handles),
            mapJsonField(validation.data.contact),
            validation.data.timezone ?? null,
            validation.data.avatar_url ?? null,
            validation.data.location ?? null,
            updatedAt
          )
          .run();

        return jsonResponse({ ok: true, updated_at: updatedAt });
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/now") {
      if (request.method === "GET") {
        const row = await env.DB.prepare("SELECT * FROM now_state WHERE id = 1").all();
        return jsonResponse(row.results[0] ?? {});
      }

      if (request.method === "PUT") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(nowSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const updatedAt = nowIso();
        await env.DB.prepare(
          `INSERT INTO now_state (id, focus, status, availability, mood, current_song, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             focus = excluded.focus,
             status = excluded.status,
             availability = excluded.availability,
             mood = excluded.mood,
             current_song = excluded.current_song,
             updated_at = excluded.updated_at`
        )
          .bind(
            validation.data.focus ?? null,
            validation.data.status ?? null,
            validation.data.availability ?? null,
            validation.data.mood ?? null,
            validation.data.current_song ?? null,
            updatedAt
          )
          .run();

        return jsonResponse({ ok: true, updated_at: updatedAt });
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/settings") {
      if (request.method === "GET") {
        const row = await env.DB.prepare("SELECT * FROM settings WHERE id = 1").all();
        return jsonResponse(
          row.results[0] ? normalizeSettings(row.results[0] as JsonRecord) : {}
        );
      }

      if (request.method === "PUT") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(settingsSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const updatedAt = nowIso();
        await env.DB.prepare(
          `INSERT INTO settings (id, public_fields_json, theme, flags_json, updated_at)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             public_fields_json = excluded.public_fields_json,
             theme = excluded.theme,
             flags_json = excluded.flags_json,
             updated_at = excluded.updated_at`
        )
          .bind(
            mapJsonField(validation.data.public_fields),
            validation.data.theme ?? null,
            mapJsonField(validation.data.flags),
            updatedAt
          )
          .run();

        return jsonResponse({ ok: true, updated_at: updatedAt });
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/projects") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM projects ORDER BY created_at DESC"
        ).all();
        const results = (rows.results ?? []).map((row) =>
          normalizeProject(row as JsonRecord)
        );
        return jsonResponse(results);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(projectSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const createdAt = nowIso();
        await env.DB.prepare(
          `INSERT INTO projects (title, description, links_json, tags_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.title,
            validation.data.description ?? null,
            mapJsonField(validation.data.links),
            mapJsonField(validation.data.tags),
            validation.data.status ?? null,
            createdAt,
            createdAt
          )
          .run();

        return jsonResponse({ ok: true, created_at: createdAt }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/notes") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM notes ORDER BY created_at DESC"
        ).all();
        const results = (rows.results ?? []).map((row) =>
          normalizeNote(row as JsonRecord)
        );
        return jsonResponse(results);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(noteSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const createdAt = nowIso();
        await env.DB.prepare(
          `INSERT INTO notes (title, body, tags_json, created_at)
           VALUES (?, ?, ?, ?)`
        )
          .bind(
            validation.data.title ?? null,
            validation.data.body ?? null,
            mapJsonField(validation.data.tags),
            createdAt
          )
          .run();

        return jsonResponse({ ok: true, created_at: createdAt }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/events") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM events ORDER BY occurred_at DESC"
        ).all();
        const results = (rows.results ?? []).map((row) =>
          normalizeEvent(row as JsonRecord)
        );
        return jsonResponse(results);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(eventSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const occurredAt = validation.data.occurred_at ?? nowIso();
        await env.DB.prepare(
          `INSERT INTO events (type, payload_json, occurred_at)
           VALUES (?, ?, ?)`
        )
          .bind(
            validation.data.type,
            mapJsonField(validation.data.payload),
            occurredAt
          )
          .run();

        return jsonResponse({ ok: true, occurred_at: occurredAt }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/posts") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM posts ORDER BY published_at DESC"
        ).all();
        const results = (rows.results ?? []).map((row) =>
          normalizePost(row as JsonRecord)
        );
        return jsonResponse(results);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(postSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const updatedAt = nowIso();
        await env.DB.prepare(
          `INSERT INTO posts (slug, title, summary, content, tags_json, published_at, pinned, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.slug,
            validation.data.title,
            validation.data.summary ?? null,
            validation.data.content ?? null,
            mapJsonField(validation.data.tags),
            validation.data.published_at ?? null,
            validation.data.pinned ? 1 : 0,
            updatedAt
          )
          .run();

        return jsonResponse({ ok: true, updated_at: updatedAt }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/uses") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM uses_items ORDER BY category, name"
        ).all();
        return jsonResponse(rows.results ?? []);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(usesItemSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const createdAt = nowIso();
        await env.DB.prepare(
          `INSERT INTO uses_items (category, name, url, note, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.category,
            validation.data.name,
            validation.data.url ?? null,
            validation.data.note ?? null,
            createdAt
          )
          .run();

        return jsonResponse({ ok: true, created_at: createdAt }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/shelf") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM shelf_items ORDER BY date_added DESC"
        ).all();
        const results = (rows.results ?? []).map((row) =>
          normalizeShelfItem(row as JsonRecord)
        );
        return jsonResponse(results);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(shelfItemSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const dateAdded = validation.data.date_added ?? nowIso();
        await env.DB.prepare(
          `INSERT INTO shelf_items (type, title, quote, author, source, url, note, image_url, drawer, tags_json, date_added)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.type,
            validation.data.title ?? null,
            validation.data.quote ?? null,
            validation.data.author ?? null,
            validation.data.source ?? null,
            validation.data.url ?? null,
            validation.data.note ?? null,
            validation.data.image_url ?? null,
            validation.data.drawer ?? null,
            mapJsonField(validation.data.tags),
            dateAdded
          )
          .run();

        return jsonResponse({ ok: true, date_added: dateAdded }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/experience") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM experience ORDER BY start_date DESC"
        ).all();
        return jsonResponse(rows.results ?? []);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(experienceSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        await env.DB.prepare(
          `INSERT INTO experience (company, role, location, start_date, end_date, employment_type, description)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.company,
            validation.data.role,
            validation.data.location ?? null,
            validation.data.start_date ?? null,
            validation.data.end_date ?? null,
            validation.data.employment_type ?? null,
            validation.data.description ?? null
          )
          .run();

        return jsonResponse({ ok: true }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/education") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM education ORDER BY start_date DESC"
        ).all();
        return jsonResponse(rows.results ?? []);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(educationSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        await env.DB.prepare(
          `INSERT INTO education (institution, degree, field, start_date, end_date, description)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.institution,
            validation.data.degree ?? null,
            validation.data.field ?? null,
            validation.data.start_date ?? null,
            validation.data.end_date ?? null,
            validation.data.description ?? null
          )
          .run();

        return jsonResponse({ ok: true }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/skills") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM skills ORDER BY category"
        ).all();
        const results = (rows.results ?? []).map((row) =>
          normalizeSkill(row as JsonRecord)
        );
        return jsonResponse(results);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(skillSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const updatedAt = nowIso();
        await env.DB.prepare(
          `INSERT INTO skills (category, items_json, updated_at)
           VALUES (?, ?, ?)`
        )
          .bind(
            validation.data.category,
            mapJsonField(validation.data.items),
            updatedAt
          )
          .run();

        return jsonResponse({ ok: true, updated_at: updatedAt }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/photos") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM photos ORDER BY shot_at DESC, created_at DESC"
        ).all();
        const results = (rows.results ?? []).map((row) =>
          normalizePhoto(row as JsonRecord)
        );
        return jsonResponse(results);
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(photoSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const createdAt = nowIso();
        await env.DB.prepare(
          `INSERT INTO photos (title, description, url, thumb_url, width, height, shot_at, camera, lens, settings, location, tags_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.title ?? null,
            validation.data.description ?? null,
            validation.data.url,
            validation.data.thumb_url ?? null,
            validation.data.width ?? null,
            validation.data.height ?? null,
            validation.data.shot_at ?? null,
            validation.data.camera ?? null,
            validation.data.lens ?? null,
            validation.data.settings ?? null,
            validation.data.location ?? null,
            mapJsonField(validation.data.tags),
            createdAt
          )
          .run();

        return jsonResponse({ ok: true, created_at: createdAt }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/status") {
      if (request.method === "GET") {
        const row = await env.DB.prepare(
          "SELECT * FROM status_snapshots ORDER BY created_at DESC LIMIT 1"
        ).all();
        return jsonResponse(
          row.results[0]
            ? normalizeStatusSnapshot(row.results[0] as JsonRecord)
            : {}
        );
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/status/refresh" && request.method === "POST") {
      if (!env.LANYARD_USER_ID) {
        return errorResponse("LANYARD_USER_ID not configured", 500);
      }

      const response = await fetch(
        `https://api.lanyard.rest/v1/users/${env.LANYARD_USER_ID}`
      );
      if (!response.ok) {
        return errorResponse("Failed to fetch status", 502);
      }

      const payload = (await response.json()) as {
        data?: {
          discord_status?: string;
          activities?: unknown[];
          spotify?: unknown;
        };
      };

      const data = payload.data ?? {};
      const activity = Array.isArray(data.activities) ? data.activities[0] : null;
      const createdAt = nowIso();

      await env.DB.prepare(
        `INSERT INTO status_snapshots (discord_status, activity_json, spotify_json, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          data.discord_status ?? null,
          mapJsonField(activity),
          mapJsonField(data.spotify ?? null),
          mapJsonField(payload),
          createdAt
        )
        .run();

      return jsonResponse(
        {
          ok: true,
          created_at: createdAt,
          discord_status: data.discord_status ?? null,
          activity,
          spotify: data.spotify ?? null,
        },
        201
      );
    }

    if (pathname === "/v1/wakatime") {
      if (request.method === "GET") {
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        const end = endParam ?? dateOnly(new Date());
        const start =
          startParam ?? dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));

        const [days, languages, projects, editors] = await Promise.all([
          env.DB.prepare(
            "SELECT * FROM wakatime_days WHERE date BETWEEN ? AND ? ORDER BY date ASC"
          )
            .bind(start, end)
            .all(),
          env.DB.prepare(
            "SELECT * FROM wakatime_languages WHERE date BETWEEN ? AND ? ORDER BY date ASC, total_seconds DESC"
          )
            .bind(start, end)
            .all(),
          env.DB.prepare(
            "SELECT * FROM wakatime_projects WHERE date BETWEEN ? AND ? ORDER BY date ASC, total_seconds DESC"
          )
            .bind(start, end)
            .all(),
          env.DB.prepare(
            "SELECT * FROM wakatime_editors WHERE date BETWEEN ? AND ? ORDER BY date ASC, total_seconds DESC"
          )
            .bind(start, end)
            .all(),
        ]);

        return jsonResponse({
          start,
          end,
          days: days.results ?? [],
          languages: languages.results ?? [],
          projects: projects.results ?? [],
          editors: editors.results ?? [],
        });
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/wakatime/hourly") {
      if (request.method === "GET") {
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        const end = endParam ?? dateOnly(new Date());
        const start =
          startParam ?? dateOnly(addDays(new Date(`${end}T00:00:00Z`), -6));

        const rows = await env.DB.prepare(
          "SELECT * FROM wakatime_hourly WHERE date BETWEEN ? AND ? ORDER BY date ASC, hour ASC"
        )
          .bind(start, end)
          .all();

        const results = (rows.results ?? []).map((row) =>
          normalizeWakaTimeHourly(row as JsonRecord)
        );

        return jsonResponse({ start, end, hours: results });
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/wakatime/refresh" && request.method === "POST") {
      try {
        const end = dateOnly(new Date());
        const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -6));
        await refreshWakaTime(env, start, end);
        await markRefreshed(env, "wakatime_daily");
        return jsonResponse({ ok: true, start, end }, 201);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "WakaTime refresh failed";
        return errorResponse(message, 502);
      }
    }

    if (pathname === "/v1/wakatime/hourly/refresh" && request.method === "POST") {
      try {
        const end = dateOnly(new Date());
        const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -6));
        await refreshWakaTimeHourly(env, start, end);
        await markRefreshed(env, "wakatime_hourly");
        return jsonResponse({ ok: true, start, end }, 201);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "WakaTime hourly refresh failed";
        return errorResponse(message, 502);
      }
    }

    if (pathname === "/v1/export" && request.method === "GET") {
      const [
        profile,
        nowState,
        settings,
        projects,
        notes,
        events,
        posts,
        usesItems,
        shelfItems,
        experience,
        education,
        skills,
        photos,
        statusSnapshots,
        wakaDays,
        wakaLanguages,
        wakaProjects,
        wakaEditors,
        wakaHourly,
      ] = await Promise.all([
        env.DB.prepare("SELECT * FROM profile WHERE id = 1").all(),
        env.DB.prepare("SELECT * FROM now_state WHERE id = 1").all(),
        env.DB.prepare("SELECT * FROM settings WHERE id = 1").all(),
        env.DB.prepare("SELECT * FROM projects ORDER BY created_at DESC").all(),
        env.DB.prepare("SELECT * FROM notes ORDER BY created_at DESC").all(),
        env.DB.prepare("SELECT * FROM events ORDER BY occurred_at DESC").all(),
        env.DB.prepare("SELECT * FROM posts ORDER BY published_at DESC").all(),
        env.DB.prepare("SELECT * FROM uses_items ORDER BY category, name").all(),
        env.DB.prepare("SELECT * FROM shelf_items ORDER BY date_added DESC").all(),
        env.DB.prepare("SELECT * FROM experience ORDER BY start_date DESC").all(),
        env.DB.prepare("SELECT * FROM education ORDER BY start_date DESC").all(),
        env.DB.prepare("SELECT * FROM skills ORDER BY category").all(),
        env.DB.prepare("SELECT * FROM photos ORDER BY shot_at DESC, created_at DESC").all(),
        env.DB.prepare(
          "SELECT * FROM status_snapshots ORDER BY created_at DESC"
        ).all(),
        env.DB.prepare("SELECT * FROM wakatime_days ORDER BY date ASC").all(),
        env.DB.prepare(
          "SELECT * FROM wakatime_languages ORDER BY date ASC, total_seconds DESC"
        ).all(),
        env.DB.prepare(
          "SELECT * FROM wakatime_projects ORDER BY date ASC, total_seconds DESC"
        ).all(),
        env.DB.prepare(
          "SELECT * FROM wakatime_editors ORDER BY date ASC, total_seconds DESC"
        ).all(),
        env.DB.prepare(
          "SELECT * FROM wakatime_hourly ORDER BY date ASC, hour ASC"
        ).all(),
      ]);

      return jsonResponse({
        profile: profile.results[0]
          ? normalizeProfile(profile.results[0] as JsonRecord)
          : {},
        now: nowState.results[0] ?? {},
        settings: settings.results[0]
          ? normalizeSettings(settings.results[0] as JsonRecord)
          : {},
        projects: (projects.results ?? []).map((row) =>
          normalizeProject(row as JsonRecord)
        ),
        notes: (notes.results ?? []).map((row) => normalizeNote(row as JsonRecord)),
        events: (events.results ?? []).map((row) =>
          normalizeEvent(row as JsonRecord)
        ),
        posts: (posts.results ?? []).map((row) =>
          normalizePost(row as JsonRecord)
        ),
        uses: usesItems.results ?? [],
        shelf: (shelfItems.results ?? []).map((row) =>
          normalizeShelfItem(row as JsonRecord)
        ),
        experience: experience.results ?? [],
        education: education.results ?? [],
        skills: (skills.results ?? []).map((row) =>
          normalizeSkill(row as JsonRecord)
        ),
        photos: (photos.results ?? []).map((row) =>
          normalizePhoto(row as JsonRecord)
        ),
        status: (statusSnapshots.results ?? []).map((row) =>
          normalizeStatusSnapshot(row as JsonRecord)
        ),
        wakatime: {
          days: wakaDays.results ?? [],
          languages: wakaLanguages.results ?? [],
          projects: wakaProjects.results ?? [],
          editors: wakaEditors.results ?? [],
          hourly: (wakaHourly.results ?? []).map((row) =>
            normalizeWakaTimeHourly(row as JsonRecord)
          ),
        },
      });
    }

    return errorResponse("Not found", 404);
  },
  async scheduled(
    _event: ScheduledEvent,
    env: Env
  ): Promise<void> {
    if (!env.LANYARD_USER_ID) {
      return;
    }

    const response = await fetch(
      `https://api.lanyard.rest/v1/users/${env.LANYARD_USER_ID}`
    );
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as {
      data?: {
        discord_status?: string;
        activities?: unknown[];
        spotify?: unknown;
      };
    };

    const data = payload.data ?? {};
    const activity = Array.isArray(data.activities) ? data.activities[0] : null;
    const createdAt = nowIso();

    await env.DB.prepare(
      `INSERT INTO status_snapshots (discord_status, activity_json, spotify_json, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        data.discord_status ?? null,
        mapJsonField(activity),
        mapJsonField(data.spotify ?? null),
        mapJsonField(payload),
        createdAt
      )
      .run();

    try {
      if (!env.WAKATIME_API_KEY) {
        return;
      }

      const today = dateOnly(new Date());
      const latest = await env.DB.prepare(
        "SELECT date FROM wakatime_days ORDER BY date DESC LIMIT 1"
      ).all();
      const latestDate =
        latest.results && latest.results[0]
          ? String((latest.results[0] as JsonRecord).date)
          : null;

      if (latestDate === today) {
        if (!(await shouldRefresh(env, "wakatime_hourly", 60))) {
          return;
        }

        const start = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -6));
        await refreshWakaTimeHourly(env, start, today);
        await markRefreshed(env, "wakatime_hourly");
        return;
      }

      const start = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -6));
      await refreshWakaTime(env, start, today);
      await markRefreshed(env, "wakatime_daily");
      if (await shouldRefresh(env, "wakatime_hourly", 60)) {
        await refreshWakaTimeHourly(env, start, today);
        await markRefreshed(env, "wakatime_hourly");
      }
    } catch {
      return;
    }
  },
};
