import { z } from "zod";
import {
  postSchema,
  photoSchema,
  projectSchema,
  SHELF_STATUSES,
  shelfItemBaseSchema,
  usesItemSchema,
} from "./content";
import {
  educationSchema,
  experienceSchema,
  nowSchema,
  profileSchema,
  skillSchema,
} from "./profile";
import { openApiRegistry } from "./openapi";

const nullableStringSchema = z.string().nullable();
const nullableIntegerSchema = z.number().int().nullable();
const d1BooleanSchema = z
  .union([z.literal(0), z.literal(1)])
  .openapi({ type: "integer", enum: [0, 1] });

const profileHandlesResponseSchema = z
  .object({
    github: z.unknown().optional(),
    linkedin: z.unknown().optional(),
    twitter: z.unknown().optional(),
  })
  .catchall(z.unknown());

const profileContactResponseSchema = z
  .object({
    email: z.unknown().optional(),
  })
  .catchall(z.unknown());

const nowProjectResponseSchema = z
  .object({
    name: z.unknown().optional(),
    status: z.unknown().optional(),
    description: z.unknown().optional(),
  })
  .catchall(z.unknown());

const shelfSectionVisibilityResponseSchema = z.object({
  visible: z.boolean(),
});

const shelfConfigResponseSchema = z.object({
  sections: z
    .object({
      links: shelfSectionVisibilityResponseSchema.optional(),
      quotes: shelfSectionVisibilityResponseSchema.optional(),
      visuals: shelfSectionVisibilityResponseSchema.optional(),
      wallpapers: shelfSectionVisibilityResponseSchema.optional(),
      books: shelfSectionVisibilityResponseSchema.optional(),
      movies: shelfSectionVisibilityResponseSchema.optional(),
      shows: shelfSectionVisibilityResponseSchema.optional(),
    })
    .optional(),
  hiddenItems: z.array(z.number()).optional(),
});

export const profileResponseSchema = openApiRegistry.register(
  "ProfileResponse",
  profileSchema.extend({
    id: z.number().int().optional(),
    name: nullableStringSchema.optional(),
    bio: nullableStringSchema.optional(),
    handles: profileHandlesResponseSchema.nullable().optional(),
    contact: profileContactResponseSchema.nullable().optional(),
    timezone: nullableStringSchema.optional(),
    avatar_url: nullableStringSchema.optional(),
    location: nullableStringSchema.optional(),
    email: nullableStringSchema.optional(),
    website: nullableStringSchema.optional(),
    image_url: nullableStringSchema.optional(),
    image_alt: nullableStringSchema.optional(),
    summary: z.array(z.string()).nullable().optional(),
    updated_at: nullableStringSchema.optional(),
  })
);

export const projectResponseSchema = openApiRegistry.register(
  "ProjectResponse",
  projectSchema.extend({
    id: z.number().int(),
    description: nullableStringSchema,
    links: z.array(z.string()).nullable(),
    tags: z.array(z.string()).nullable(),
    status: nullableStringSchema,
    sort_order: nullableIntegerSchema,
    published: d1BooleanSchema,
    created_at: nullableStringSchema,
    updated_at: nullableStringSchema,
  })
);
export const projectsResponseSchema = z.array(projectResponseSchema);

export const postResponseSchema = openApiRegistry.register(
  "PostResponse",
  postSchema.extend({
    id: z.number().int(),
    summary: nullableStringSchema,
    content: nullableStringSchema,
    tags: z.array(z.string()).nullable(),
    published_at: nullableStringSchema,
    pinned: z.boolean(),
    published: z.boolean(),
    created_at: nullableStringSchema,
    updated_at: nullableStringSchema,
  })
);
export const postsResponseSchema = z.array(postResponseSchema);

export const photoResponseSchema = openApiRegistry.register(
  "PhotoResponse",
  photoSchema.extend({
    id: z.number().int(),
    title: nullableStringSchema,
    description: nullableStringSchema,
    thumb_url: nullableStringSchema,
    width: nullableIntegerSchema,
    height: nullableIntegerSchema,
    shot_at: nullableStringSchema,
    camera: nullableStringSchema,
    lens: nullableStringSchema,
    settings: nullableStringSchema,
    location: nullableStringSchema,
    tags: z.array(z.string()).nullable(),
    published: d1BooleanSchema,
    created_at: nullableStringSchema,
    updated_at: nullableStringSchema,
  })
);
export const photosResponseSchema = z.array(photoResponseSchema);

export const experienceResponseSchema = openApiRegistry.register(
  "ExperienceResponse",
  experienceSchema.extend({
    id: z.number().int(),
    location: nullableStringSchema,
    start_date: nullableStringSchema,
    end_date: nullableStringSchema,
    employment_type: nullableStringSchema,
    description: nullableStringSchema,
    published: d1BooleanSchema,
    created_at: nullableStringSchema,
    updated_at: nullableStringSchema,
  })
);
export const experiencesResponseSchema = z.array(experienceResponseSchema);

export const educationResponseSchema = openApiRegistry.register(
  "EducationResponse",
  educationSchema.extend({
    id: z.number().int(),
    degree: nullableStringSchema,
    field: nullableStringSchema,
    start_date: nullableStringSchema,
    end_date: nullableStringSchema,
    description: nullableStringSchema,
    published: d1BooleanSchema,
    created_at: nullableStringSchema,
    updated_at: nullableStringSchema,
  })
);
export const educationListResponseSchema = z.array(educationResponseSchema);

export const skillResponseSchema = openApiRegistry.register(
  "SkillResponse",
  skillSchema.extend({
    id: z.number().int(),
    items: z.array(z.string()).nullable(),
    published: d1BooleanSchema,
    created_at: nullableStringSchema,
    updated_at: nullableStringSchema,
  })
);
export const skillsResponseSchema = z.array(skillResponseSchema);

export const nowResponseSchema = openApiRegistry.register(
  "NowResponse",
  nowSchema.extend({
    id: z.number().int().optional(),
    focus: nullableStringSchema.optional(),
    status: nullableStringSchema.optional(),
    availability: nullableStringSchema.optional(),
    mood: nullableStringSchema.optional(),
    current_song: nullableStringSchema.optional(),
    learning: z.array(z.string()).nullable().optional(),
    projects: z.array(nowProjectResponseSchema).nullable().optional(),
    life: z.array(z.string()).nullable().optional(),
    reading_goal: nullableStringSchema.optional(),
    last_updated: nullableStringSchema.optional(),
    updated_at: nullableStringSchema.optional(),
  })
);

export const usesItemResponseSchema = openApiRegistry.register(
  "UsesItemResponse",
  usesItemSchema.extend({
    id: z.number().int(),
    url: nullableStringSchema,
    note: nullableStringSchema,
    published: d1BooleanSchema,
    created_at: nullableStringSchema,
    updated_at: nullableStringSchema,
  })
);
export const usesResponseSchema = z.array(usesItemResponseSchema);

export const settingsResponseSchema = openApiRegistry.register(
  "SettingsResponse",
  z.object({
    id: z.number().int().optional(),
    public_fields: z.array(z.string()).nullable(),
    theme: nullableStringSchema,
    flags: z.record(z.unknown()).nullable(),
    shelf_config: shelfConfigResponseSchema.nullable(),
    updated_at: nullableStringSchema.optional(),
  })
);

export const shelfItemResponseSchema = openApiRegistry.register(
  "ShelfItemResponse",
  shelfItemBaseSchema.extend({
    id: z.number().int(),
    title: nullableStringSchema,
    quote: nullableStringSchema,
    author: nullableStringSchema,
    source: nullableStringSchema,
    url: nullableStringSchema,
    note: nullableStringSchema,
    image_url: nullableStringSchema,
    drawer: nullableStringSchema,
    tags: z
      .union([z.array(z.string()), z.record(z.unknown())])
      .nullable(),
    date_added: nullableStringSchema,
    published: z.boolean(),
    status: z.enum(SHELF_STATUSES).nullable(),
    rating: z.number().nullable(),
    rating_scale: z.union([z.literal(5), z.literal(10)]).nullable(),
    started_at: nullableStringSchema,
    completed_at: nullableStringSchema,
    last_watched_at: nullableStringSchema,
    progress_current: z.number().nullable(),
    progress_total: z.number().nullable(),
    progress_unit: nullableStringSchema,
    favorite_rank: nullableIntegerSchema,
    showcase: z.boolean(),
    metadata: z.record(z.unknown()).nullable(),
    shelf_group: nullableStringSchema,
    display_order: nullableIntegerSchema,
    cover_override_url: nullableStringSchema,
    spine_image_url: nullableStringSchema,
    goodreads_id: nullableStringSchema,
    isbn: nullableStringSchema,
    apple_books_id: nullableStringSchema,
    created_at: nullableStringSchema,
    updated_at: nullableStringSchema,
  })
);
export const shelfResponseSchema = z.array(shelfItemResponseSchema);

const githubDailyResponseSchema = z.object({
  date: z.string(),
  count: nullableIntegerSchema,
  created_at: nullableStringSchema,
  personal_count: z.number().int(),
  work_count: z.number().int(),
});

const githubRepoResponseSchema = z.object({
  range_start: z.string(),
  range_end: z.string(),
  repo: z.string(),
  count: nullableIntegerSchema,
});

export const githubResponseSchema = openApiRegistry.register(
  "GitHubResponse",
  z.object({
    start: z.string(),
    end: z.string(),
    daily: z.array(githubDailyResponseSchema),
    repos: z.array(githubRepoResponseSchema),
  })
);

const wakatimeDayResponseSchema = z.object({
  date: z.string(),
  total_seconds: z.number().nullable(),
  total_minutes: nullableIntegerSchema,
  timezone: nullableStringSchema,
  created_at: nullableStringSchema,
});

const wakatimeBreakdownResponseSchema = z.object({
  date: z.string(),
  name: z.string(),
  total_seconds: z.number().nullable(),
  total_minutes: nullableIntegerSchema,
  percent: z.number().nullable(),
});

export const wakatimeResponseSchema = openApiRegistry.register(
  "WakaTimeResponse",
  z.object({
    start: z.string(),
    end: z.string(),
    days: z.array(wakatimeDayResponseSchema),
    languages: z.array(wakatimeBreakdownResponseSchema),
    projects: z.array(wakatimeBreakdownResponseSchema),
    editors: z.array(wakatimeBreakdownResponseSchema),
  })
);

const wakatimeHourResponseSchema = z.object({
  date: z.string(),
  hour: z.number().int(),
  seconds: z.number().nullable(),
  languages: z.record(z.number()),
});

export const wakatimeHourlyResponseSchema = openApiRegistry.register(
  "WakaTimeHourlyResponse",
  z.object({
    start: z.string(),
    end: z.string(),
    hours: z.array(wakatimeHourResponseSchema),
  })
);
