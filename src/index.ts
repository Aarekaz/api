import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

export interface Env {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  API_TOKEN: string;
  LANYARD_USER_ID: string;
  WAKATIME_API_KEY: string;
  WAKATIME_TIMEZONE: string;
  GITHUB_USERNAME: string;
  GITHUB_TOKEN: string;
  API_VERSION: string;
  R2_PUBLIC_BASE_URL: string;
}

type JsonRecord = Record<string, unknown>;

type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

extendZodWithOpenApi(z);

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

const backfillSchema = z.object({
  start: dateString,
  end: dateString,
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

// Apple Health Schemas
const appleHealthDailySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
  // Heart & Cardiovascular
  resting_heart_rate: z.number().positive().optional(),
  heart_rate_avg: z.number().positive().optional(),
  heart_rate_min: z.number().positive().optional(),
  heart_rate_max: z.number().positive().optional(),
  hrv_avg: z.number().nonnegative().optional(),
  vo2_max: z.number().positive().optional(),
  blood_oxygen_avg: z.number().min(0).max(100).optional(),
  blood_oxygen_min: z.number().min(0).max(100).optional(),
  // Body Measurements
  weight: z.number().positive().optional(),
  body_fat_percentage: z.number().min(0).max(100).optional(),
  body_mass_index: z.number().positive().optional(),
  wrist_temperature: z.number().optional(), // Can be negative (below baseline)
  // Activity
  steps: z.number().int().nonnegative().optional(),
  active_energy: z.number().nonnegative().optional(),
  resting_energy: z.number().nonnegative().optional(),
  exercise_minutes: z.number().int().nonnegative().optional(),
  stand_hours: z.number().int().min(0).max(24).optional(),
  flights_climbed: z.number().int().nonnegative().optional(),
  distance_walking_running: z.number().nonnegative().optional(),
  // Sleep
  sleep_duration_minutes: z.number().int().nonnegative().optional(),
  sleep_deep_minutes: z.number().int().nonnegative().optional(),
  sleep_core_minutes: z.number().int().nonnegative().optional(),
  sleep_rem_minutes: z.number().int().nonnegative().optional(),
  sleep_awake_minutes: z.number().int().nonnegative().optional(),
  respiratory_rate_avg: z.number().positive().optional(),
  // Mindfulness
  mindful_minutes: z.number().int().nonnegative().optional(),
  // Blood Pressure
  blood_pressure_systolic: z.number().int().positive().optional(),
  blood_pressure_diastolic: z.number().int().positive().optional(),
  // Nutrition & Hydration
  water_intake_ml: z.number().int().nonnegative().optional(),
  caffeine_mg: z.number().int().nonnegative().optional(),
  // Metadata
  source: z.string().optional(),
  notes: z.string().optional(),
});

const appleHealthHeartRateSchema = z.object({
  recorded_at: dateString,
  heart_rate: z.number().positive(),
  context: z.string().optional(),
  source: z.string().optional(),
});

const appleHealthHeartRateBatchSchema = z.object({
  samples: z.array(appleHealthHeartRateSchema).min(1).max(1000),
});

const appleHealthSleepSessionSchema = z.object({
  start_at: dateString,
  end_at: dateString,
  duration_minutes: z.number().int().nonnegative().optional(),
  deep_minutes: z.number().int().nonnegative().optional(),
  core_minutes: z.number().int().nonnegative().optional(),
  rem_minutes: z.number().int().nonnegative().optional(),
  awake_minutes: z.number().int().nonnegative().optional(),
  sleep_quality_score: z.number().min(0).max(100).optional(),
  respiratory_rate_avg: z.number().positive().optional(),
  heart_rate_avg: z.number().positive().optional(),
  hrv_avg: z.number().nonnegative().optional(),
});

const appleHealthWorkoutSchema = z.object({
  workout_type: z.string().min(1),
  start_at: dateString,
  end_at: dateString,
  duration_minutes: z.number().int().nonnegative().optional(),
  active_energy: z.number().nonnegative().optional(),
  heart_rate_avg: z.number().positive().optional(),
  heart_rate_max: z.number().positive().optional(),
  distance: z.number().nonnegative().optional(),
  elevation_gain: z.number().nonnegative().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
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

const openApiRegistry = new OpenAPIRegistry();
const dateTimeSchema = z.string().openapi({ format: "date-time" });
const dateSchema = z.string().openapi({ format: "date" });
const genericObjectSchema = z.record(z.unknown());
const genericArraySchema = z.array(z.record(z.unknown()));
const imageUploadSchema = z.string().openapi({ format: "binary" });

const errorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

const okSchema = z.object({ ok: z.boolean() });
const okUpdatedSchema = z.object({ ok: z.boolean(), updated_at: dateTimeSchema });
const okCreatedSchema = z.object({ ok: z.boolean(), created_at: dateTimeSchema });
const okOccurredSchema = z.object({ ok: z.boolean(), occurred_at: dateTimeSchema });
const okDateAddedSchema = z.object({ ok: z.boolean(), date_added: dateTimeSchema });
const okDateRangeSchema = z.object({
  ok: z.boolean(),
  start: dateSchema,
  end: dateSchema,
});
const photoUploadResponseSchema = z.object({
  ok: z.boolean(),
  key: z.string(),
  url: z.string(),
  content_type: z.string(),
});
const statusRefreshResponseSchema = z.object({
  ok: z.boolean(),
  created_at: dateTimeSchema,
  discord_status: z.string().nullable().optional(),
  activity: z.unknown().nullable().optional(),
  spotify: z.unknown().nullable().optional(),
});
const healthResponseSchema = z.object({
  status: z.string(),
  version: z.string(),
  timestamp: dateTimeSchema,
});
const rangeQuerySchema = z.object({
  start: dateString.optional(),
  end: dateString.optional(),
});

const openApiJsonContent = (schema: z.ZodTypeAny) => ({
  "application/json": { schema },
});

const openApiJsonContentWithExample = (
  schema: z.ZodTypeAny,
  example: unknown
) => ({
  "application/json": { schema, example },
});

const openApiJsonRequestBody = (schema: z.ZodTypeAny, description?: string) => ({
  description,
  content: openApiJsonContent(schema),
});

const openApiResponse = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: openApiJsonContent(schema),
});

const openApiResponseWithExample = (
  schema: z.ZodTypeAny,
  description: string,
  example: unknown
) => ({
  description,
  content: openApiJsonContentWithExample(schema, example),
});

const errorResponses = {
  400: openApiResponse(errorSchema, "Bad request"),
  401: openApiResponse(errorSchema, "Unauthorized"),
  403: openApiResponse(errorSchema, "Forbidden"),
  500: openApiResponse(errorSchema, "Server error"),
};

const okResponses = (schema: z.ZodTypeAny, description = "OK") => ({
  200: openApiResponse(schema, description),
  ...errorResponses,
});

const createdResponses = (schema: z.ZodTypeAny, description = "Created") => ({
  201: openApiResponse(schema, description),
  ...errorResponses,
});

const authSecurity = [{ bearerAuth: [] as string[] }];

openApiRegistry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  security: authSecurity,
  responses: okResponses(healthResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/openapi.json",
  summary: "OpenAPI document",
  security: [],
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/profile",
  summary: "Fetch profile",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/profile",
  summary: "Update profile",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(profileSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/now",
  summary: "Fetch current status",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/now",
  summary: "Update current status",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(nowSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/settings",
  summary: "Fetch settings",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/settings",
  summary: "Update settings",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(settingsSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/projects",
  summary: "List projects",
  security: authSecurity,
  responses: {
    200: openApiResponseWithExample(genericArraySchema, "OK", [
      {
        id: 1,
        title: "Personal API",
        description: "Cloudflare Worker + D1.",
        links: ["https://api.example.com", "https://github.com/user/repo"],
        tags: ["cloudflare", "typescript"],
        status: "active",
        created_at: "2025-01-05T12:34:56.000Z",
        updated_at: "2025-01-05T12:34:56.000Z",
      },
    ]),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/projects",
  summary: "Create project",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(projectSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/notes",
  summary: "List notes",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/notes",
  summary: "Create note",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(noteSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/events",
  summary: "List events",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/events",
  summary: "Create event",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(eventSchema) },
  responses: createdResponses(okOccurredSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/posts",
  summary: "List posts",
  security: authSecurity,
  responses: {
    200: openApiResponseWithExample(genericArraySchema, "OK", [
      {
        id: 10,
        slug: "launch-notes",
        title: "Launch Notes",
        summary: "Short summary",
        content: "Full content",
        tags: ["release", "notes"],
        published_at: "2024-10-01T00:00:00.000Z",
        pinned: true,
        updated_at: "2024-10-01T00:00:00.000Z",
      },
    ]),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/posts",
  summary: "Create post",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(postSchema) },
  responses: createdResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/uses",
  summary: "List uses",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/uses",
  summary: "Create uses item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(usesItemSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/shelf",
  summary: "List shelf items",
  security: authSecurity,
  responses: {
    200: openApiResponseWithExample(genericArraySchema, "OK", [
      {
        id: 7,
        type: "book",
        title: "The Pragmatic Programmer",
        quote: "Care about your craft.",
        author: "Andy Hunt",
        source: "Addison-Wesley",
        url: "https://example.com/book",
        note: "Re-read yearly",
        image_url: "https://example.com/cover.jpg",
        drawer: "reading",
        tags: ["software", "career"],
        date_added: "2025-02-14T12:00:00.000Z",
      },
    ]),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/shelf",
  summary: "Create shelf item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfItemSchema) },
  responses: createdResponses(okDateAddedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/experience",
  summary: "List experience",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/experience",
  summary: "Create experience",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(experienceSchema) },
  responses: createdResponses(okSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/education",
  summary: "List education",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/education",
  summary: "Create education",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(educationSchema) },
  responses: createdResponses(okSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/skills",
  summary: "List skills",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/skills",
  summary: "Create skill",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(skillSchema) },
  responses: createdResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/photos",
  summary: "List photos",
  security: authSecurity,
  responses: {
    200: openApiResponseWithExample(genericArraySchema, "OK", [
      {
        id: 42,
        title: "Ocean",
        description: "Sunset shot.",
        url: "https://cdn.example.com/photos/abc.jpg",
        thumb_url: "https://cdn.example.com/photos/abc_thumb.jpg",
        width: 2048,
        height: 1365,
        shot_at: "2024-08-12T18:30:00.000Z",
        camera: "Sony A7C",
        lens: "35mm",
        settings: "f/2.8 1/200 ISO 100",
        location: "San Diego, CA",
        tags: ["sunset", "ocean"],
        created_at: "2024-08-12T18:45:00.000Z",
      },
    ]),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos",
  summary: "Create photo",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(photoSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/photos/upload",
  summary: "Upload photo to R2",
  security: authSecurity,
  request: {
    body: {
      description: "Raw image bytes with an image/* content type.",
      content: {
        "image/*": { schema: imageUploadSchema },
      },
    },
  },
  responses: createdResponses(photoUploadResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/status",
  summary: "Fetch latest status snapshot",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/status/refresh",
  summary: "Refresh status snapshot",
  security: authSecurity,
  responses: createdResponses(statusRefreshResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wakatime",
  summary: "Fetch WakaTime daily summaries",
  security: authSecurity,
  request: { query: rangeQuerySchema },
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/wakatime/refresh",
  summary: "Refresh WakaTime daily data",
  security: authSecurity,
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/wakatime/backfill",
  summary: "Backfill WakaTime daily data",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(backfillSchema) },
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wakatime/hourly",
  summary: "Fetch WakaTime hourly data",
  security: authSecurity,
  request: { query: rangeQuerySchema },
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/wakatime/hourly/refresh",
  summary: "Refresh WakaTime hourly data",
  security: authSecurity,
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/wakatime/hourly/backfill",
  summary: "Backfill WakaTime hourly data",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(backfillSchema) },
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/github",
  summary: "Fetch GitHub contributions",
  security: authSecurity,
  request: { query: rangeQuerySchema },
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/github/refresh",
  summary: "Refresh GitHub contributions",
  security: authSecurity,
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/github/backfill",
  summary: "Backfill GitHub contributions",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(backfillSchema) },
  responses: createdResponses(okDateRangeSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/refresh",
  summary: "Refresh status, WakaTime, and GitHub",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/day",
  summary: "Fetch daily wrapped stats",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/week",
  summary: "Fetch weekly wrapped stats",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/month",
  summary: "Fetch monthly wrapped stats",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/wrapped/2026",
  summary: "Fetch 2026 wrapped stats",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/export",
  summary: "Export all data",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

const openApiDocument = new OpenApiGeneratorV3(
  openApiRegistry.definitions
).generateDocument({
  openapi: "3.1.0",
  info: {
    title: "Personal API",
    version: "v1",
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API token",
      },
    },
  },
  security: authSecurity,
});

function getOpenApiDocument(apiVersion?: string): JsonRecord {
  if (!apiVersion) {
    return openApiDocument as JsonRecord;
  }

  return {
    ...openApiDocument,
    info: {
      ...openApiDocument.info,
      version: apiVersion,
    },
  } as JsonRecord;
}

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

function fileExtensionForContentType(contentType: string): string {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return "jpg";
  }
  if (normalized === "image/png") {
    return "png";
  }
  if (normalized === "image/webp") {
    return "webp";
  }
  if (normalized === "image/avif") {
    return "avif";
  }
  return "bin";
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysBetween(start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00Z`).getTime();
  const endDate = new Date(`${end}T00:00:00Z`).getTime();
  if (Number.isNaN(startDate) || Number.isNaN(endDate)) {
    return 0;
  }
  return Math.floor((endDate - startDate) / 86400000) + 1;
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

async function refreshGitHub(
  env: Env,
  start: string,
  end: string
): Promise<void> {
  if (!env.GITHUB_USERNAME || !env.GITHUB_TOKEN) {
    throw new Error("GITHUB_USERNAME or GITHUB_TOKEN not configured");
  }

  const query = `
    query($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
          commitContributionsByRepository {
            contributions {
              totalCount
            }
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "personal-api",
    },
    body: JSON.stringify({
      query,
      variables: {
        username: env.GITHUB_USERNAME,
        from: `${start}T00:00:00Z`,
        to: `${end}T23:59:59Z`,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: {
      user?: {
        contributionsCollection?: {
          contributionCalendar?: {
            weeks?: Array<{
              contributionDays?: Array<{
                date?: string;
                contributionCount?: number;
              }>;
            }>;
          };
          commitContributionsByRepository?: Array<{
            contributions?: { totalCount?: number };
            repository?: { nameWithOwner?: string };
          }>;
        };
      };
    };
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    const message = payload.errors
      .map((error) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(message || "GitHub GraphQL error");
  }

  const collection = payload.data?.user?.contributionsCollection;
  const calendar = collection?.contributionCalendar;
  const weeks = calendar?.weeks ?? [];
  const createdAt = nowIso();

  for (const week of weeks) {
    const days = week.contributionDays ?? [];
    for (const day of days) {
      if (!day.date) {
        continue;
      }
      await env.DB.prepare(
        `INSERT INTO github_daily (date, count, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           count = excluded.count,
           created_at = excluded.created_at`
      )
        .bind(day.date, day.contributionCount ?? 0, createdAt)
        .run();
    }
  }

  await env.DB.prepare(
    "DELETE FROM github_repo_totals WHERE range_start = ? AND range_end = ?"
  )
    .bind(start, end)
    .run();

  const repos = collection?.commitContributionsByRepository ?? [];
  for (const repo of repos) {
    const name = repo.repository?.nameWithOwner;
    if (!name) {
      continue;
    }
    const count = repo.contributions?.totalCount ?? 0;
    await env.DB.prepare(
      `INSERT INTO github_repo_totals (range_start, range_end, repo, count)
       VALUES (?, ?, ?, ?)`
    )
      .bind(start, end, name, count)
      .run();
  }
}

async function buildWrapped(
  env: Env,
  start: string,
  end: string
): Promise<JsonRecord> {
  const [
    codingTotal,
    codingDaily,
    topLanguages,
    topProjects,
    topEditors,
    githubTotal,
    githubDaily,
    githubRepos,
  ] = await Promise.all([
    env.DB.prepare(
      "SELECT SUM(total_seconds) AS total_seconds FROM wakatime_days WHERE date BETWEEN ? AND ?"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT date, total_seconds, total_minutes FROM wakatime_days WHERE date BETWEEN ? AND ? ORDER BY date ASC"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT name, SUM(total_seconds) AS total_seconds FROM wakatime_languages WHERE date BETWEEN ? AND ? GROUP BY name ORDER BY total_seconds DESC LIMIT 10"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT name, SUM(total_seconds) AS total_seconds FROM wakatime_projects WHERE date BETWEEN ? AND ? GROUP BY name ORDER BY total_seconds DESC LIMIT 10"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT name, SUM(total_seconds) AS total_seconds FROM wakatime_editors WHERE date BETWEEN ? AND ? GROUP BY name ORDER BY total_seconds DESC LIMIT 10"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT SUM(count) AS total_count FROM github_daily WHERE date BETWEEN ? AND ?"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT date, count FROM github_daily WHERE date BETWEEN ? AND ? ORDER BY date ASC"
    )
      .bind(start, end)
      .all(),
    env.DB.prepare(
      "SELECT repo, count FROM github_repo_totals WHERE range_start = ? AND range_end = ? ORDER BY count DESC LIMIT 10"
    )
      .bind(start, end)
      .all(),
  ]);

  const codingTotalSeconds =
    codingTotal.results && codingTotal.results[0]
      ? Number((codingTotal.results[0] as JsonRecord).total_seconds ?? 0)
      : 0;

  const githubTotalCount =
    githubTotal.results && githubTotal.results[0]
      ? Number((githubTotal.results[0] as JsonRecord).total_count ?? 0)
      : 0;

  return {
    range: { start, end },
    coding: {
      total_seconds: codingTotalSeconds,
      daily: codingDaily.results ?? [],
      top_languages: topLanguages.results ?? [],
      top_projects: topProjects.results ?? [],
      top_editors: topEditors.results ?? [],
    },
    github: {
      total_contributions: githubTotalCount,
      daily: githubDaily.results ?? [],
      top_repos: githubRepos.results ?? [],
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/openapi.json") {
      return jsonResponse(getOpenApiDocument(env.API_VERSION));
    }

    if (pathname === "/health") {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      return jsonResponse({
        status: "ok",
        version: env.API_VERSION ?? "unknown",
        timestamp: nowIso(),
      });
    }

    if (pathname === "/") {
      const version = env.API_VERSION ?? "unknown";
      return jsonResponse({
        title: "Personal API",
        author: "Anurag Dhungana",
        website: "https://www.anuragd.me",
        version,
        status: "ok",
        timestamp: nowIso(),
        schemaVersion: 1,
        label: "api",
        message: version,
        color: "blue",
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

    if (pathname === "/v1/photos/upload" && request.method === "POST") {
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        return errorResponse("Unsupported content type", 415);
      }

      const contentLength = request.headers.get("content-length");
      if (contentLength && Number(contentLength) > 10 * 1024 * 1024) {
        return errorResponse("File too large", 413);
      }

      if (!request.body) {
        return errorResponse("Missing body", 400);
      }

      const ext = fileExtensionForContentType(contentType);
      const key = `photos/${crypto.randomUUID()}.${ext}`;

      await env.R2_BUCKET.put(key, request.body, {
        httpMetadata: { contentType },
      });

      const baseUrl = env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
      const url = baseUrl ? `${baseUrl}/${key}` : key;

      return jsonResponse(
        {
          ok: true,
          key,
          url,
          content_type: contentType,
        },
        201
      );
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

    if (pathname === "/v1/github") {
      if (request.method === "GET") {
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        const end = endParam ?? dateOnly(new Date());
        const start =
          startParam ?? dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));

        const [daily, repos] = await Promise.all([
          env.DB.prepare(
            "SELECT * FROM github_daily WHERE date BETWEEN ? AND ? ORDER BY date ASC"
          )
            .bind(start, end)
            .all(),
          env.DB.prepare(
            "SELECT * FROM github_repo_totals WHERE range_start = ? AND range_end = ? ORDER BY count DESC"
          )
            .bind(start, end)
            .all(),
        ]);

        return jsonResponse({
          start,
          end,
          daily: daily.results ?? [],
          repos: repos.results ?? [],
        });
      }

      return errorResponse("Method not allowed", 405);
    }

    if (pathname === "/v1/github/refresh" && request.method === "POST") {
      try {
        const end = dateOnly(new Date());
        const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));
        await refreshGitHub(env, start, end);
        await markRefreshed(env, "github_refresh");
        return jsonResponse({ ok: true, start, end }, 201);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "GitHub refresh failed";
        return errorResponse(message, 502);
      }
    }

    if (pathname === "/v1/github/backfill" && request.method === "POST") {
      const body = await parseJson(request);
      if (body === null) {
        return errorResponse("Invalid JSON", 400);
      }

      const validation = validateBody(backfillSchema, body);
      if (!validation.ok) {
        return validation.response;
      }

      const { start, end } = validation.data;
      if (start > end) {
        return errorResponse("Start date must be before end date", 400);
      }

      if (daysBetween(start, end) > 370) {
        return errorResponse("Backfill range too large", 400);
      }

      try {
        await refreshGitHub(env, start, end);
        await markRefreshed(env, "github_refresh");
        return jsonResponse({ ok: true, start, end }, 201);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "GitHub backfill failed";
        return errorResponse(message, 502);
      }
    }

    if (pathname.startsWith("/v1/wrapped")) {
      if (request.method !== "GET") {
        return errorResponse("Method not allowed", 405);
      }

      const today = dateOnly(new Date());
      if (pathname === "/v1/wrapped/day") {
        const start = today;
        const end = today;
        return jsonResponse(await buildWrapped(env, start, end));
      }

      if (pathname === "/v1/wrapped/week") {
        const end = today;
        const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -6));
        return jsonResponse(await buildWrapped(env, start, end));
      }

      if (pathname === "/v1/wrapped/month") {
        const end = today;
        const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));
        return jsonResponse(await buildWrapped(env, start, end));
      }

      if (pathname === "/v1/wrapped/2026") {
        return jsonResponse(await buildWrapped(env, "2026-01-01", "2026-12-31"));
      }

      return errorResponse("Not found", 404);
    }

    if (pathname === "/v1/wakatime/backfill" && request.method === "POST") {
      const body = await parseJson(request);
      if (body === null) {
        return errorResponse("Invalid JSON", 400);
      }

      const validation = validateBody(backfillSchema, body);
      if (!validation.ok) {
        return validation.response;
      }

      const { start, end } = validation.data;
      if (start > end) {
        return errorResponse("Start date must be before end date", 400);
      }

      if (daysBetween(start, end) > 370) {
        return errorResponse("Backfill range too large", 400);
      }

      try {
        await refreshWakaTime(env, start, end);
        await markRefreshed(env, "wakatime_daily");
        return jsonResponse({ ok: true, start, end }, 201);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "WakaTime backfill failed";
        return errorResponse(message, 502);
      }
    }

    if (
      pathname === "/v1/wakatime/hourly/backfill" &&
      request.method === "POST"
    ) {
      const body = await parseJson(request);
      if (body === null) {
        return errorResponse("Invalid JSON", 400);
      }

      const validation = validateBody(backfillSchema, body);
      if (!validation.ok) {
        return validation.response;
      }

      const { start, end } = validation.data;
      if (start > end) {
        return errorResponse("Start date must be before end date", 400);
      }

      if (daysBetween(start, end) > 90) {
        return errorResponse("Hourly backfill range too large", 400);
      }

      try {
        await refreshWakaTimeHourly(env, start, end);
        await markRefreshed(env, "wakatime_hourly");
        return jsonResponse({ ok: true, start, end }, 201);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "WakaTime hourly backfill failed";
        return errorResponse(message, 502);
      }
    }

    if (pathname === "/v1/refresh" && request.method === "POST") {
      const results: JsonRecord = {};
      const today = dateOnly(new Date());
      const lastWeek = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -6));
      const lastMonth = dateOnly(addDays(new Date(`${today}T00:00:00Z`), -29));

      if (env.LANYARD_USER_ID) {
        try {
          const response = await fetch(
            `https://api.lanyard.rest/v1/users/${env.LANYARD_USER_ID}`
          );
          if (!response.ok) {
            throw new Error(`Lanyard request failed with ${response.status}`);
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

          results.status = { ok: true, created_at: createdAt };
        } catch (error) {
          results.status = {
            ok: false,
            error: error instanceof Error ? error.message : "Status refresh failed",
          };
        }
      } else {
        results.status = { ok: false, error: "LANYARD_USER_ID not configured" };
      }

      if (env.WAKATIME_API_KEY) {
        try {
          await refreshWakaTime(env, lastWeek, today);
          await markRefreshed(env, "wakatime_daily");
          results.wakatime = { ok: true, start: lastWeek, end: today };
        } catch (error) {
          results.wakatime = {
            ok: false,
            error: error instanceof Error ? error.message : "WakaTime refresh failed",
          };
        }

        try {
          await refreshWakaTimeHourly(env, lastWeek, today);
          await markRefreshed(env, "wakatime_hourly");
          results.wakatime_hourly = { ok: true, start: lastWeek, end: today };
        } catch (error) {
          results.wakatime_hourly = {
            ok: false,
            error:
              error instanceof Error ? error.message : "WakaTime hourly refresh failed",
          };
        }
      } else {
        results.wakatime = { ok: false, error: "WAKATIME_API_KEY not configured" };
        results.wakatime_hourly = {
          ok: false,
          error: "WAKATIME_API_KEY not configured",
        };
      }

      if (env.GITHUB_USERNAME && env.GITHUB_TOKEN) {
        try {
          await refreshGitHub(env, lastMonth, today);
          await markRefreshed(env, "github_refresh");
          results.github = { ok: true, start: lastMonth, end: today };
        } catch (error) {
          results.github = {
            ok: false,
            error: error instanceof Error ? error.message : "GitHub refresh failed",
          };
        }
      } else {
        results.github = {
          ok: false,
          error: "GITHUB_USERNAME or GITHUB_TOKEN not configured",
        };
      }

      return jsonResponse(results);
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
        githubDaily,
        githubRepos,
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
        env.DB.prepare("SELECT * FROM github_daily ORDER BY date ASC").all(),
        env.DB.prepare(
          "SELECT * FROM github_repo_totals ORDER BY range_start ASC, count DESC"
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
        github: {
          daily: githubDaily.results ?? [],
          repos: githubRepos.results ?? [],
        },
      });
    }

    // Apple Health Daily Data
    if (pathname === "/v1/health") {
      if (request.method === "GET") {
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        const end = endParam ?? dateOnly(new Date());
        const start =
          startParam ?? dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));

        const rows = await env.DB.prepare(
          "SELECT * FROM apple_health_daily WHERE date BETWEEN ? AND ? ORDER BY date DESC"
        )
          .bind(start, end)
          .all();

        return jsonResponse({
          start,
          end,
          days: rows.results ?? [],
        });
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(appleHealthDailySchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const now = nowIso();
        await env.DB.prepare(
          `INSERT INTO apple_health_daily (
            date, resting_heart_rate, heart_rate_avg, heart_rate_min, heart_rate_max,
            hrv_avg, vo2_max, blood_oxygen_avg, blood_oxygen_min,
            weight, body_fat_percentage, body_mass_index, wrist_temperature,
            steps, active_energy, resting_energy, exercise_minutes, stand_hours,
            flights_climbed, distance_walking_running,
            sleep_duration_minutes, sleep_deep_minutes, sleep_core_minutes,
            sleep_rem_minutes, sleep_awake_minutes, respiratory_rate_avg,
            mindful_minutes, blood_pressure_systolic, blood_pressure_diastolic,
            water_intake_ml, caffeine_mg, source, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(date) DO UPDATE SET
            resting_heart_rate = COALESCE(excluded.resting_heart_rate, apple_health_daily.resting_heart_rate),
            heart_rate_avg = COALESCE(excluded.heart_rate_avg, apple_health_daily.heart_rate_avg),
            heart_rate_min = COALESCE(excluded.heart_rate_min, apple_health_daily.heart_rate_min),
            heart_rate_max = COALESCE(excluded.heart_rate_max, apple_health_daily.heart_rate_max),
            hrv_avg = COALESCE(excluded.hrv_avg, apple_health_daily.hrv_avg),
            vo2_max = COALESCE(excluded.vo2_max, apple_health_daily.vo2_max),
            blood_oxygen_avg = COALESCE(excluded.blood_oxygen_avg, apple_health_daily.blood_oxygen_avg),
            blood_oxygen_min = COALESCE(excluded.blood_oxygen_min, apple_health_daily.blood_oxygen_min),
            weight = COALESCE(excluded.weight, apple_health_daily.weight),
            body_fat_percentage = COALESCE(excluded.body_fat_percentage, apple_health_daily.body_fat_percentage),
            body_mass_index = COALESCE(excluded.body_mass_index, apple_health_daily.body_mass_index),
            wrist_temperature = COALESCE(excluded.wrist_temperature, apple_health_daily.wrist_temperature),
            steps = COALESCE(excluded.steps, apple_health_daily.steps),
            active_energy = COALESCE(excluded.active_energy, apple_health_daily.active_energy),
            resting_energy = COALESCE(excluded.resting_energy, apple_health_daily.resting_energy),
            exercise_minutes = COALESCE(excluded.exercise_minutes, apple_health_daily.exercise_minutes),
            stand_hours = COALESCE(excluded.stand_hours, apple_health_daily.stand_hours),
            flights_climbed = COALESCE(excluded.flights_climbed, apple_health_daily.flights_climbed),
            distance_walking_running = COALESCE(excluded.distance_walking_running, apple_health_daily.distance_walking_running),
            sleep_duration_minutes = COALESCE(excluded.sleep_duration_minutes, apple_health_daily.sleep_duration_minutes),
            sleep_deep_minutes = COALESCE(excluded.sleep_deep_minutes, apple_health_daily.sleep_deep_minutes),
            sleep_core_minutes = COALESCE(excluded.sleep_core_minutes, apple_health_daily.sleep_core_minutes),
            sleep_rem_minutes = COALESCE(excluded.sleep_rem_minutes, apple_health_daily.sleep_rem_minutes),
            sleep_awake_minutes = COALESCE(excluded.sleep_awake_minutes, apple_health_daily.sleep_awake_minutes),
            respiratory_rate_avg = COALESCE(excluded.respiratory_rate_avg, apple_health_daily.respiratory_rate_avg),
            mindful_minutes = COALESCE(excluded.mindful_minutes, apple_health_daily.mindful_minutes),
            blood_pressure_systolic = COALESCE(excluded.blood_pressure_systolic, apple_health_daily.blood_pressure_systolic),
            blood_pressure_diastolic = COALESCE(excluded.blood_pressure_diastolic, apple_health_daily.blood_pressure_diastolic),
            water_intake_ml = COALESCE(excluded.water_intake_ml, apple_health_daily.water_intake_ml),
            caffeine_mg = COALESCE(excluded.caffeine_mg, apple_health_daily.caffeine_mg),
            source = COALESCE(excluded.source, apple_health_daily.source),
            notes = COALESCE(excluded.notes, apple_health_daily.notes),
            updated_at = excluded.updated_at`
        )
          .bind(
            validation.data.date,
            validation.data.resting_heart_rate ?? null,
            validation.data.heart_rate_avg ?? null,
            validation.data.heart_rate_min ?? null,
            validation.data.heart_rate_max ?? null,
            validation.data.hrv_avg ?? null,
            validation.data.vo2_max ?? null,
            validation.data.blood_oxygen_avg ?? null,
            validation.data.blood_oxygen_min ?? null,
            validation.data.weight ?? null,
            validation.data.body_fat_percentage ?? null,
            validation.data.body_mass_index ?? null,
            validation.data.wrist_temperature ?? null,
            validation.data.steps ?? null,
            validation.data.active_energy ?? null,
            validation.data.resting_energy ?? null,
            validation.data.exercise_minutes ?? null,
            validation.data.stand_hours ?? null,
            validation.data.flights_climbed ?? null,
            validation.data.distance_walking_running ?? null,
            validation.data.sleep_duration_minutes ?? null,
            validation.data.sleep_deep_minutes ?? null,
            validation.data.sleep_core_minutes ?? null,
            validation.data.sleep_rem_minutes ?? null,
            validation.data.sleep_awake_minutes ?? null,
            validation.data.respiratory_rate_avg ?? null,
            validation.data.mindful_minutes ?? null,
            validation.data.blood_pressure_systolic ?? null,
            validation.data.blood_pressure_diastolic ?? null,
            validation.data.water_intake_ml ?? null,
            validation.data.caffeine_mg ?? null,
            validation.data.source ?? null,
            validation.data.notes ?? null,
            now,
            now
          )
          .run();

        return jsonResponse({ ok: true, date: validation.data.date, updated_at: now }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    // Apple Health - Get specific day
    if (pathname.match(/^\/v1\/health\/\d{4}-\d{2}-\d{2}$/)) {
      const dateMatch = pathname.match(/\/v1\/health\/(\d{4}-\d{2}-\d{2})$/);
      if (!dateMatch) {
        return errorResponse("Invalid date format", 400);
      }

      const date = dateMatch[1];

      if (request.method === "GET") {
        const row = await env.DB.prepare(
          "SELECT * FROM apple_health_daily WHERE date = ?"
        )
          .bind(date)
          .all();

        if (!row.results || row.results.length === 0) {
          return errorResponse("No data found for this date", 404);
        }

        return jsonResponse(row.results[0] as JsonRecord);
      }

      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM apple_health_daily WHERE date = ?")
          .bind(date)
          .run();
        return jsonResponse({ ok: true, deleted: date });
      }

      return errorResponse("Method not allowed", 405);
    }

    // Apple Health Heart Rate samples
    if (pathname === "/v1/health/heart-rate") {
      if (request.method === "GET") {
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        const limitParam = url.searchParams.get("limit");
        const end = endParam ?? nowIso();
        const start =
          startParam ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const limit = Math.min(Number(limitParam) || 1000, 10000);

        const rows = await env.DB.prepare(
          "SELECT * FROM apple_health_heart_rate WHERE recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC LIMIT ?"
        )
          .bind(start, end, limit)
          .all();

        return jsonResponse({
          start,
          end,
          count: rows.results?.length ?? 0,
          samples: rows.results ?? [],
        });
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        // Check if it's a batch request
        const batchValidation = appleHealthHeartRateBatchSchema.safeParse(body);
        if (batchValidation.success) {
          const samples = batchValidation.data.samples;
          const now = nowIso();
          let inserted = 0;

          for (const sample of samples) {
            await env.DB.prepare(
              `INSERT INTO apple_health_heart_rate (recorded_at, heart_rate, context, source, created_at)
               VALUES (?, ?, ?, ?, ?)`
            )
              .bind(
                sample.recorded_at,
                sample.heart_rate,
                sample.context ?? null,
                sample.source ?? null,
                now
              )
              .run();
            inserted += 1;
          }

          return jsonResponse({ ok: true, inserted, created_at: now }, 201);
        }

        // Single sample
        const validation = validateBody(appleHealthHeartRateSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const now = nowIso();
        await env.DB.prepare(
          `INSERT INTO apple_health_heart_rate (recorded_at, heart_rate, context, source, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.recorded_at,
            validation.data.heart_rate,
            validation.data.context ?? null,
            validation.data.source ?? null,
            now
          )
          .run();

        return jsonResponse({ ok: true, created_at: now }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    // Apple Health Sleep Sessions
    if (pathname === "/v1/health/sleep") {
      if (request.method === "GET") {
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        const limitParam = url.searchParams.get("limit");
        const end = endParam ?? nowIso();
        const start =
          startParam ?? dateOnly(addDays(new Date(), -30));
        const limit = Math.min(Number(limitParam) || 100, 1000);

        const rows = await env.DB.prepare(
          "SELECT * FROM apple_health_sleep_sessions WHERE start_at >= ? AND end_at <= ? ORDER BY start_at DESC LIMIT ?"
        )
          .bind(start, end, limit)
          .all();

        return jsonResponse({
          start,
          end,
          count: rows.results?.length ?? 0,
          sessions: rows.results ?? [],
        });
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(appleHealthSleepSessionSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const now = nowIso();
        await env.DB.prepare(
          `INSERT INTO apple_health_sleep_sessions (
            start_at, end_at, duration_minutes, deep_minutes, core_minutes,
            rem_minutes, awake_minutes, sleep_quality_score,
            respiratory_rate_avg, heart_rate_avg, hrv_avg, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.start_at,
            validation.data.end_at,
            validation.data.duration_minutes ?? null,
            validation.data.deep_minutes ?? null,
            validation.data.core_minutes ?? null,
            validation.data.rem_minutes ?? null,
            validation.data.awake_minutes ?? null,
            validation.data.sleep_quality_score ?? null,
            validation.data.respiratory_rate_avg ?? null,
            validation.data.heart_rate_avg ?? null,
            validation.data.hrv_avg ?? null,
            now
          )
          .run();

        return jsonResponse({ ok: true, created_at: now }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    // Apple Health Workouts
    if (pathname === "/v1/health/workouts") {
      if (request.method === "GET") {
        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        const typeParam = url.searchParams.get("type");
        const limitParam = url.searchParams.get("limit");
        const end = endParam ?? nowIso();
        const start =
          startParam ?? dateOnly(addDays(new Date(), -30));
        const limit = Math.min(Number(limitParam) || 100, 1000);

        let query =
          "SELECT * FROM apple_health_workouts WHERE start_at >= ? AND end_at <= ?";
        const params: (string | number)[] = [start, end];

        if (typeParam) {
          query += " AND workout_type = ?";
          params.push(typeParam);
        }

        query += " ORDER BY start_at DESC LIMIT ?";
        params.push(limit);

        const rows = await env.DB.prepare(query)
          .bind(...params)
          .all();

        return jsonResponse({
          start,
          end,
          count: rows.results?.length ?? 0,
          workouts: rows.results ?? [],
        });
      }

      if (request.method === "POST") {
        const body = await parseJson(request);
        if (body === null) {
          return errorResponse("Invalid JSON", 400);
        }

        const validation = validateBody(appleHealthWorkoutSchema, body);
        if (!validation.ok) {
          return validation.response;
        }

        const now = nowIso();
        await env.DB.prepare(
          `INSERT INTO apple_health_workouts (
            workout_type, start_at, end_at, duration_minutes, active_energy,
            heart_rate_avg, heart_rate_max, distance, elevation_gain,
            source, notes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            validation.data.workout_type,
            validation.data.start_at,
            validation.data.end_at,
            validation.data.duration_minutes ?? null,
            validation.data.active_energy ?? null,
            validation.data.heart_rate_avg ?? null,
            validation.data.heart_rate_max ?? null,
            validation.data.distance ?? null,
            validation.data.elevation_gain ?? null,
            validation.data.source ?? null,
            validation.data.notes ?? null,
            now
          )
          .run();

        return jsonResponse({ ok: true, created_at: now }, 201);
      }

      return errorResponse("Method not allowed", 405);
    }

    // Apple Health Summary (latest data across all metrics)
    if (pathname === "/v1/health/summary" && request.method === "GET") {
      const [latestDaily, recentSleep, recentWorkouts] = await Promise.all([
        env.DB.prepare(
          "SELECT * FROM apple_health_daily ORDER BY date DESC LIMIT 7"
        ).all(),
        env.DB.prepare(
          "SELECT * FROM apple_health_sleep_sessions ORDER BY start_at DESC LIMIT 7"
        ).all(),
        env.DB.prepare(
          "SELECT * FROM apple_health_workouts ORDER BY start_at DESC LIMIT 10"
        ).all(),
      ]);

      const dailyData = latestDaily.results ?? [];
      const latest = dailyData[0] as JsonRecord | undefined;

      // Calculate averages from last 7 days
      const avgSteps = dailyData.length > 0
        ? Math.round(
            dailyData.reduce((sum, d) => sum + (Number((d as JsonRecord).steps) || 0), 0) /
              dailyData.filter((d) => (d as JsonRecord).steps != null).length || 1
          )
        : null;

      const avgRestingHR = dailyData.length > 0
        ? Math.round(
            dailyData.reduce(
              (sum, d) => sum + (Number((d as JsonRecord).resting_heart_rate) || 0),
              0
            ) /
              dailyData.filter((d) => (d as JsonRecord).resting_heart_rate != null).length || 1
          )
        : null;

      return jsonResponse({
        latest: latest ?? null,
        averages_7_days: {
          steps: avgSteps,
          resting_heart_rate: avgRestingHR,
        },
        recent_days: dailyData,
        recent_sleep: recentSleep.results ?? [],
        recent_workouts: recentWorkouts.results ?? [],
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

    try {
      if (!env.GITHUB_TOKEN || !env.GITHUB_USERNAME) {
        return;
      }

      if (!(await shouldRefresh(env, "github_refresh", 1440))) {
        return;
      }

      const end = dateOnly(new Date());
      const start = dateOnly(addDays(new Date(`${end}T00:00:00Z`), -29));
      await refreshGitHub(env, start, end);
      await markRefreshed(env, "github_refresh");
    } catch {
      return;
    }
  },
};
