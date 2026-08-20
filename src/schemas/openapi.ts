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
