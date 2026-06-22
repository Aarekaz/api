import { z } from "zod";
import { dateString } from "./common";

export const projectSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  links: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
  sort_order: z.number().int().optional(),
  published: z.boolean().optional(),
});

export const noteSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const eventSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  occurred_at: dateString.optional(),
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
  return "other";
}

export function statusMatchesShelfType(type: string, status: string) {
  const kind = shelfKindForType(type);
  if (kind === "book") return BOOK_SHELF_STATUSES.includes(status as typeof BOOK_SHELF_STATUSES[number]);
  if (kind === "movie") return MOVIE_SHELF_STATUSES.includes(status as typeof MOVIE_SHELF_STATUSES[number]);
  if (kind === "show") return SHOW_SHELF_STATUSES.includes(status as typeof SHOW_SHELF_STATUSES[number]);
  return false;
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
  display_order: z.number().int().optional(),
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
