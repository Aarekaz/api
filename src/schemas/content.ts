import { z } from "zod";
import { dateString } from "./common";

export const PROJECT_LISTING_STATUSES = ["available", "in_review"] as const;
export const PROJECT_LISTING_PLATFORM_PATTERN = /^[a-z0-9-]{1,32}$/;
export const PROJECT_LISTINGS_MAX = 12;
export const PROJECT_HIGHLIGHT_MAX_LENGTH = 80;
export const PROJECT_LISTING_URL_MAX_LENGTH = 500;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const projectListingSchema = z.object({
  platform: z
    .string()
    .regex(PROJECT_LISTING_PLATFORM_PATTERN, "Platform must be a lowercase slug (a-z, 0-9, -), 1-32 chars"),
  status: z.enum(PROJECT_LISTING_STATUSES),
  url: z
    .string()
    .max(PROJECT_LISTING_URL_MAX_LENGTH)
    .url()
    .refine(isHttpsUrl, { message: "URL must use https" })
    .nullable()
    .default(null),
});

export const projectListingsSchema = z
  .array(projectListingSchema)
  .max(PROJECT_LISTINGS_MAX)
  .superRefine((listings, ctx) => {
    const seen = new Set<string>();
    listings.forEach((listing, index) => {
      if (seen.has(listing.platform)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "platform"],
          message: `Duplicate listing platform: ${listing.platform}`,
        });
      }
      seen.add(listing.platform);
    });
  });

export const projectSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  links: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
  sort_order: z.number().int().optional(),
  published: z.boolean().optional(),
  featured: z.boolean().optional(),
  highlight: z.string().trim().max(PROJECT_HIGHLIGHT_MAX_LENGTH).nullable().optional(),
  listings: projectListingsSchema.optional(),
});

export const postSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  published_at: dateString.optional(),
  pinned: z.boolean().optional(),
});

export const usesItemSchema = z.object({
  category: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url().optional(),
  note: z.string().optional(),
  published: z.boolean().optional(),
});

const shelfTagsSchema = z.union([z.array(z.string()), z.record(z.unknown())]);

export const BOOK_SHELF_STATUSES = [
  "library",
  "reading",
  "completed",
  "want_to_read",
  "paused",
  "dnf",
] as const;

export const MOVIE_SHELF_STATUSES = [
  "watched",
  "watching",
  "want_to_watch",
] as const;

export const SHOW_SHELF_STATUSES = [
  "watching",
  "completed",
  "want_to_watch",
  "paused",
  "dropped",
] as const;

// Anime follows AniList's lists (planning, watching, completed, paused,
// dropped), spelled with the show statuses the site already knows.
export const ANIME_SHELF_STATUSES = SHOW_SHELF_STATUSES;

/** Types the Library tracks. "anime" is app-only for now (see routes/shelf.ts). */
export const SHELF_MEDIA_TYPES = ["book", "movie", "show", "anime"] as const;

export const SHELF_STATUSES = [
  "library",
  "reading",
  "completed",
  "want_to_read",
  "paused",
  "dnf",
  "watched",
  "watching",
  "want_to_watch",
  "dropped",
] as const;

const shelfStatusSchema = z.enum(SHELF_STATUSES);

function shelfKindForType(type: string) {
  const normalized = type.toLowerCase();
  if (normalized === "book") return "book";
  if (normalized === "movie" || normalized === "film") return "movie";
  if (normalized === "show" || normalized === "tv" || normalized === "series") return "show";
  if (normalized === "anime") return "anime";
  return "other";
}

export function statusMatchesShelfType(type: string, status: string) {
  const kind = shelfKindForType(type);
  if (kind === "book") return BOOK_SHELF_STATUSES.includes(status as typeof BOOK_SHELF_STATUSES[number]);
  if (kind === "movie") return MOVIE_SHELF_STATUSES.includes(status as typeof MOVIE_SHELF_STATUSES[number]);
  if (kind === "show") return SHOW_SHELF_STATUSES.includes(status as typeof SHOW_SHELF_STATUSES[number]);
  if (kind === "anime") return ANIME_SHELF_STATUSES.includes(status as typeof ANIME_SHELF_STATUSES[number]);
  return false;
}

/** The status that means "finished" for a shelf type (books and shows say completed, movies watched). */
export function finishedStatusFor(type: string): string | null {
  const kind = shelfKindForType(type);
  if (kind === "movie") return "watched";
  if (kind === "book" || kind === "show" || kind === "anime") return "completed";
  return null;
}

/** The status that means "in progress" for a shelf type. */
export function activeStatusFor(type: string): string | null {
  const kind = shelfKindForType(type);
  if (kind === "book") return "reading";
  if (kind === "movie" || kind === "show" || kind === "anime") return "watching";
  return null;
}

/** The status that means "want to" for a shelf type. */
export function queuedStatusFor(type: string): string | null {
  const kind = shelfKindForType(type);
  if (kind === "book") return "want_to_read";
  if (kind === "movie" || kind === "show" || kind === "anime") return "want_to_watch";
  return null;
}

/** Paused and dropped, where the type has them (movies have neither; books say dnf). */
export function stoppedStatusFor(type: string, kind: "paused" | "dropped"): string | null {
  const shelfKind = shelfKindForType(type);
  if (kind === "paused") return shelfKind === "movie" || shelfKind === "other" ? null : "paused";
  if (shelfKind === "book") return "dnf";
  return shelfKind === "show" || shelfKind === "anime" ? "dropped" : null;
}

/**
 * A copy of a request schema with OpenAPI descriptions on some fields, for the
 * docs only (the routes validate with the plain schema). The project, post,
 * uses, shelf and photo schemas here are also the base of the website's
 * response schemas (schemas/responses.ts, frozen by the contract test), so
 * their own fields stay undescribed. It calls .openapi() only when a route
 * file calls it, after schemas/openapi.ts has extended zod; nothing here calls
 * it at import.
 */
export type FieldDoc = string | { description: string; deprecated?: boolean };
export function describedFields<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  docs: { [K in keyof T]?: FieldDoc }
) {
  const shape: z.ZodRawShape = {};
  for (const [key, doc] of Object.entries(docs) as [keyof T & string, FieldDoc][]) {
    shape[key] = schema.shape[key].openapi(typeof doc === "string" ? { description: doc } : doc);
  }
  return schema.extend(shape);
}

export const shelfItemBaseSchema = z.object({
  type: z.string().min(1),
  title: z.string().optional(),
  quote: z.string().optional(),
  author: z.string().optional(),
  source: z.string().optional(),
  url: z.string().url().optional(),
  note: z.string().optional(),
  image_url: z.string().url().optional(),
  drawer: z.string().optional(),
  tags: shelfTagsSchema.optional(),
  date_added: dateString.optional(),
  published: z.boolean().optional(),
  status: shelfStatusSchema.optional(),
  rating: z.number().min(0).max(10).optional(),
  rating_scale: z.union([z.literal(5), z.literal(10)]).optional(),
  started_at: dateString.optional(),
  completed_at: dateString.optional(),
  last_watched_at: dateString.optional(),
  progress_current: z.number().min(0).optional(),
  progress_total: z.number().min(0).optional(),
  progress_unit: z.string().optional(),
  favorite_rank: z.number().int().positive().optional(),
  showcase: z.boolean().optional(),
  shelf_group: z.string().optional(),
  display_order: z.number().int().min(0).optional(),
  cover_override_url: z.string().url().optional(),
  spine_image_url: z.string().url().optional(),
  goodreads_id: z.string().optional(),
  isbn: z.string().optional(),
  apple_books_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const shelfItemSchema = shelfItemBaseSchema.superRefine((data, ctx) => {
  if (!data.status) return;
  if (statusMatchesShelfType(data.type, data.status)) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["status"],
    message: `Invalid ${data.type} shelf status: ${data.status}`,
  });
});

export const SHELF_LOG_KINDS = ["started", "progress", "finished", "paused", "dropped", "want", "rated", "note"] as const;

/** One diary entry, sent to POST /v1/shelf/:id/log. Everything but kind is optional. */
export const shelfLogSchema = z.object({
  kind: z.enum(SHELF_LOG_KINDS),
  logged_at: dateString.optional(),
  status: shelfStatusSchema.optional(),
  progress_current: z.number().min(0).optional(),
  progress_total: z.number().min(0).optional(),
  progress_unit: z.string().max(32).optional(),
  season: z.number().int().min(0).max(1000).optional(),
  episode: z.number().int().min(0).max(100000).optional(),
  rating: z.number().min(0).max(10).optional(),
  rating_scale: z.union([z.literal(5), z.literal(10)]).optional(),
  note: z.string().max(20000).optional(),
  rewatch: z.boolean().optional(),
});

/** Fixing a diary entry later: its date, rating, note or rewatch mark. */
export const shelfLogPatchObject = z.object({
  logged_at: dateString.optional(),
  rating: z.number().min(0).max(10).nullable().optional(),
  note: z.string().max(20000).nullable().optional(),
  rewatch: z.boolean().optional(),
});
export const shelfLogPatchSchema = shelfLogPatchObject
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export const photoSchema = z.object({
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
  published: z.boolean().optional(),
});
