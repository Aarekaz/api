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
      });
    }

    return errorResponse("Not found", 404);
  },
};
