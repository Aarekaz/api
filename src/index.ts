import { z } from "zod";

export interface Env {
  DB: D1Database;
  API_TOKEN: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/health") {
      return jsonResponse({ status: "ok", timestamp: nowIso() });
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

    if (pathname === "/v1/export" && request.method === "GET") {
      const [profile, nowState, settings, projects, notes, events] = await Promise.all([
        env.DB.prepare("SELECT * FROM profile WHERE id = 1").all(),
        env.DB.prepare("SELECT * FROM now_state WHERE id = 1").all(),
        env.DB.prepare("SELECT * FROM settings WHERE id = 1").all(),
        env.DB.prepare("SELECT * FROM projects ORDER BY created_at DESC").all(),
        env.DB.prepare("SELECT * FROM notes ORDER BY created_at DESC").all(),
        env.DB.prepare("SELECT * FROM events ORDER BY occurred_at DESC").all(),
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
      });
    }

    return errorResponse("Not found", 404);
  },
};
