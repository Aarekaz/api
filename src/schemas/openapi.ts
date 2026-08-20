import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export const openApiRegistry = new OpenAPIRegistry();

// OpenAPI-specific schemas
export const dateTimeSchema = z.string().openapi({ format: "date-time" });
export const dateSchema = z.string().openapi({ format: "date" });
export const genericObjectSchema = z.record(z.unknown());
export const genericArraySchema = z.array(z.record(z.unknown()));
export const imageUploadSchema = z.string().openapi({ format: "binary" });

// Response schemas
export const errorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

export const okSchema = z.object({ ok: z.boolean() });
export const okUpdatedSchema = z.object({ ok: z.boolean(), updated_at: dateTimeSchema });
export const okCreatedSchema = z.object({ ok: z.boolean(), created_at: dateTimeSchema });
export const okDeletedSchema = z.object({
  ok: z.boolean(),
  deleted_at: dateTimeSchema,
  id: z.number().optional(),
});
export const okOccurredSchema = z.object({ ok: z.boolean(), occurred_at: dateTimeSchema });
export const okDateAddedSchema = z.object({ ok: z.boolean(), date_added: dateTimeSchema });
export const okDateRangeSchema = z.object({
  ok: z.boolean(),
  start: dateSchema,
  end: dateSchema,
});

export const photoUploadResponseSchema = z.object({
  ok: z.boolean(),
  key: z.string(),
  url: z.string(),
  content_type: z.string(),
});

export const statusRefreshResponseSchema = z.object({
  ok: z.boolean(),
  created_at: dateTimeSchema,
  discord_status: z.string().nullable().optional(),
  activity: z.unknown().nullable().optional(),
  spotify: z.unknown().nullable().optional(),
});

export const healthResponseSchema = z.object({
  status: z.string(),
  version: z.string(),
  timestamp: dateTimeSchema,
});

// Apple Health response schemas
export const healthDailyRangeResponseSchema = z.object({
  start: dateSchema,
  end: dateSchema,
  days: genericArraySchema,
});

export const healthDailyUpdateResponseSchema = z.object({
  ok: z.boolean(),
  date: dateSchema,
  updated_at: dateTimeSchema,
});

export const healthDailyDeleteResponseSchema = z.object({
  ok: z.boolean(),
  deleted: dateSchema,
});

export const healthHeartRateRangeResponseSchema = z.object({
  start: dateTimeSchema,
  end: dateTimeSchema,
  count: z.number(),
  samples: genericArraySchema,
});

export const healthHeartRateBatchResponseSchema = z.object({
  ok: z.boolean(),
  inserted: z.number(),
  created_at: dateTimeSchema,
});

export const healthSleepRangeResponseSchema = z.object({
  start: dateTimeSchema,
  end: dateTimeSchema,
  count: z.number(),
  sessions: genericArraySchema,
});

export const healthWorkoutsRangeResponseSchema = z.object({
  start: dateTimeSchema,
  end: dateTimeSchema,
  count: z.number(),
  workouts: genericArraySchema,
});

export const healthSummaryResponseSchema = genericObjectSchema;

export const whoopAuthorizationUrlResponseSchema = z.object({
  authorization_url: z.string().url(),
});

export const whoopIntegrationStatusResponseSchema = z.object({
  status: z.enum([
    "not_connected",
    "connecting",
    "backfilling",
    "active",
    "needs_reauth",
    "disconnected",
    "error",
  ]),
  granted_scopes: z.array(z.string()).optional(),
  connected_at: dateTimeSchema.nullable().optional(),
  refreshed_at: dateTimeSchema.nullable().optional(),
  last_success_at: dateTimeSchema.nullable().optional(),
  last_error_at: dateTimeSchema.nullable().optional(),
  disconnected_at: dateTimeSchema.nullable().optional(),
  last_error: z.string().nullable().optional(),
  consecutive_failure_count: z.number().optional(),
  updated_at: dateTimeSchema.optional(),
  progress: z.array(z.object({
    resource: z.enum(["profile", "body_measurement", "cycle", "recovery", "sleep", "workout"]),
    mode: z.enum(["backfill", "reconcile", "webhook"]),
    status: z.enum(["queued", "running", "complete", "failed"]),
    page_count: z.number().int().nonnegative(),
    record_count: z.number().int().nonnegative(),
    updated_at: dateTimeSchema,
    last_error: z.string().nullable(),
  })),
});

const whoopReadScoreStateSchema = z.enum(["scored", "pending", "unscorable"]);
const nullableNumberSchema = z.number().nullable();
const nullableDateTimeSchema = dateTimeSchema.nullable();

const hasValidCalendarDate = (value: string): boolean => {
  const date = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!date) return false;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
};

export const whoopHealthTimestampSchema = z.string()
  .datetime({ offset: true })
  .refine(hasValidCalendarDate)
  .openapi({ format: "date-time" });

export const whoopHealthCollectionQuerySchema = z.object({
  start: whoopHealthTimestampSchema.optional().openapi({
    param: { name: "start", in: "query" },
    description: "Inclusive provider timestamp lower bound",
    example: "2026-08-01T00:00:00.000Z",
  }),
  end: whoopHealthTimestampSchema.optional().openapi({
    param: { name: "end", in: "query" },
    description: "Inclusive provider timestamp upper bound",
    example: "2026-08-20T23:59:59.999Z",
  }),
  limit: z.number().int().min(1).max(100).optional().openapi({
    param: { name: "limit", in: "query" },
    description: "Page size from 1 through 100",
    example: 25,
  }),
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional().openapi({
    param: { name: "cursor", in: "query" },
    description: "Opaque local continuation cursor bound to this resource and date window",
  }),
}).strict();

export const whoopWorkoutPathSchema = z.object({
  workoutId: z.string().uuid().openapi({
    param: { name: "workoutId", in: "path" },
  }),
});

export const whoopCycleReadSchema = z.object({
  cycle_id: z.number().int().positive(),
  start_at: dateTimeSchema,
  end_at: nullableDateTimeSchema,
  timezone_offset: z.string().nullable(),
  score_state: whoopReadScoreStateSchema,
  strain: nullableNumberSchema,
  kilojoules: nullableNumberSchema,
  energy_kcal_estimate: nullableNumberSchema,
  average_heart_rate: nullableNumberSchema,
  max_heart_rate: nullableNumberSchema,
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  synced_at: dateTimeSchema,
}).strict();

export const whoopRecoveryReadSchema = z.object({
  sleep_id: z.string().uuid(),
  cycle_id: z.number().int().positive(),
  score_state: whoopReadScoreStateSchema,
  user_calibrating: z.boolean().nullable(),
  score: nullableNumberSchema,
  resting_heart_rate: nullableNumberSchema,
  hrv_rmssd_milliseconds: nullableNumberSchema,
  spo2_percentage: nullableNumberSchema,
  skin_temperature_celsius: nullableNumberSchema,
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  synced_at: dateTimeSchema,
}).strict();

export const whoopSleepReadSchema = z.object({
  sleep_id: z.string().uuid(),
  cycle_id: z.number().int().positive(),
  start_at: nullableDateTimeSchema,
  end_at: nullableDateTimeSchema,
  timezone_offset: z.string().nullable(),
  nap: z.boolean().nullable(),
  score_state: whoopReadScoreStateSchema,
  stage_durations_seconds: z.object({
    awake_seconds: nullableNumberSchema,
    light_seconds: nullableNumberSchema,
    slow_wave_seconds: nullableNumberSchema,
    rem_seconds: nullableNumberSchema,
  }).strict(),
  sleep_need_seconds: z.object({
    baseline_seconds: nullableNumberSchema,
    debt_seconds: nullableNumberSchema,
  }).strict(),
  sleep_efficiency_percentage: nullableNumberSchema,
  sleep_consistency_percentage: nullableNumberSchema,
  sleep_performance_percentage: nullableNumberSchema,
  respiratory_rate: nullableNumberSchema,
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  synced_at: dateTimeSchema,
}).strict();

const whoopZoneDurationsSchema = z.object({
  zone_zero_seconds: nullableNumberSchema,
  zone_one_seconds: nullableNumberSchema,
  zone_two_seconds: nullableNumberSchema,
  zone_three_seconds: nullableNumberSchema,
  zone_four_seconds: nullableNumberSchema,
  zone_five_seconds: nullableNumberSchema,
}).strict();

export const whoopWorkoutReadSchema = z.object({
  workout_id: z.string().uuid(),
  start_at: nullableDateTimeSchema,
  end_at: nullableDateTimeSchema,
  timezone_offset: z.string().nullable(),
  sport_id: z.number().int().nullable(),
  sport_name: z.string().nullable(),
  score_state: whoopReadScoreStateSchema,
  strain: nullableNumberSchema,
  average_heart_rate: nullableNumberSchema,
  max_heart_rate: nullableNumberSchema,
  kilojoules: nullableNumberSchema,
  energy_kcal_estimate: nullableNumberSchema,
  percent_recorded: nullableNumberSchema,
  distance_meter: nullableNumberSchema,
  elevation_gain_meter: nullableNumberSchema,
  zone_durations_seconds: whoopZoneDurationsSchema,
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  synced_at: dateTimeSchema,
}).strict();

export const whoopProfileReadSchema = z.object({
  whoop_user_id: z.number().int().positive(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  created_at: nullableDateTimeSchema,
  updated_at: nullableDateTimeSchema,
  synced_at: dateTimeSchema,
}).strict();

export const whoopHealthPageSchema = <T extends z.ZodTypeAny>(record: T) => z.object({
  records: z.array(record),
  next_cursor: z.string().nullable(),
}).strict();

const whoopTrendPointSchema = z.object({
  date: dateSchema,
  recovery_score: nullableNumberSchema,
  strain: nullableNumberSchema,
  sleep_performance_percentage: nullableNumberSchema,
}).strict();

const whoopSynchronizationSchema = z.object({
  status: z.enum([
    "not_connected", "connecting", "backfilling", "active",
    "needs_reauth", "disconnected", "error",
  ]),
  last_success_at: nullableDateTimeSchema.optional(),
  last_error_at: nullableDateTimeSchema.optional(),
  consecutive_failure_count: z.number().int().nonnegative().optional(),
  updated_at: nullableDateTimeSchema.optional(),
  progress: z.array(z.object({
    resource: z.enum(["profile", "body_measurement", "cycle", "recovery", "sleep", "workout"]),
    mode: z.enum(["backfill", "reconcile", "webhook"]),
    status: z.enum(["queued", "running", "retrying", "complete", "failed", "error"]),
    page_count: z.number().int().nonnegative(),
    record_count: z.number().int().nonnegative(),
    updated_at: dateTimeSchema,
  }).strict()),
}).strict();

export const whoopOverviewReadSchema = z.object({
  current_cycle: whoopCycleReadSchema.nullable(),
  current_recovery: whoopRecoveryReadSchema.nullable(),
  current_sleep: whoopSleepReadSchema.nullable(),
  recent_workouts: z.array(whoopWorkoutReadSchema),
  trends_7_days: z.array(whoopTrendPointSchema),
  trends_30_days: z.array(whoopTrendPointSchema),
  synchronization: whoopSynchronizationSchema,
}).strict();

// OpenAPI helper functions
export const openApiJsonContent = (schema: z.ZodTypeAny) => ({
  "application/json": { schema },
});

export const openApiJsonContentWithExample = (
  schema: z.ZodTypeAny,
  example: unknown
) => ({
  "application/json": { schema, example },
});

export const openApiJsonRequestBody = (schema: z.ZodTypeAny, description?: string) => ({
  description,
  content: openApiJsonContent(schema),
});

export const openApiResponse = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: openApiJsonContent(schema),
});

export const openApiResponseWithExample = (
  schema: z.ZodTypeAny,
  description: string,
  example: unknown
) => ({
  description,
  content: openApiJsonContentWithExample(schema, example),
});

export const errorResponses = {
  400: openApiResponse(errorSchema, "Bad request"),
  401: openApiResponse(errorSchema, "Unauthorized"),
  403: openApiResponse(errorSchema, "Forbidden"),
  500: openApiResponse(errorSchema, "Server error"),
};

export const okResponses = (schema: z.ZodTypeAny, description = "OK") => ({
  200: openApiResponse(schema, description),
  ...errorResponses,
});

export const createdResponses = (schema: z.ZodTypeAny, description = "Created") => ({
  201: openApiResponse(schema, description),
  ...errorResponses,
});

// Security configuration
openApiRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "API token",
});

export const authSecurity = [{ bearerAuth: [] as string[] }];

// OpenAPI document generator
export function getOpenApiDocument(version: string, baseUrl?: string) {
  const generator = new OpenApiGeneratorV3(openApiRegistry.definitions);
  
  // Use provided base URL or default to relative path
  const servers = baseUrl 
    ? [{ url: baseUrl, description: "API Server" }]
    : [{ url: "/", description: "Relative path (configure API_BASE_URL)" }];
  
  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      version,
      title: "Personal API",
      description: "Personal API for tracking activities, health data, and more",
    },
    servers,
  });
}
