import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseStoredJson } from "../utils/json";
import { appErrors, body } from "../lib/http";
import { normalizeProfile } from "../utils/normalizers";
import {
  apiTags,
  authSecurity,
  dateTimeSchema,
  openApiJsonRequestBody,
  openApiRegistry,
  structuredOkResponses,
} from "../schemas/openapi";
import { profileResponseSchema, shelfConfigResponseSchema } from "../schemas/responses";

// Site control: small, safe writes for what anuragd.me reads, used by the
// native app's Site space. Everything here is additive: the site keeps reading
// GET /v1/profile and GET /v1/settings exactly as before.
//
// PATCH /v1/site/profile         change some profile fields, keep the rest
// PATCH /v1/site/shelf-sections  show or hide /shelf sections, all seven of them

// Errors in the one shape (lib/http.ts).
const app = appErrors(new Hono<{ Bindings: Env }>(), "Site request");

// MARK: Profile

const text = z.string().max(4000).nullable();
const handleMap = z.record(z.string().max(200).nullable());

/** Every field optional; null clears it. Unknown keys are rejected, not dropped. */
export const profilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).openapi({ description: "Your name, the heading of the home page and /resume" }),
    bio: text.openapi({ description: "One line under the name on the home page" }),
    location: text.openapi({ description: "Where you live, as you'd write it. Shown on the site" }),
    email: text.openapi({ description: "Shown on the site" }),
    website: text.openapi({ description: "A link, shown on the site" }),
    timezone: text.openapi({ description: "An IANA name like \"America/New_York\". Stored, not shown on the site" }),
    image_url: text.openapi({ description: "Your photo, as a link. Stored as given, not copied" }),
    image_alt: text.openapi({ description: "What the photo shows, for screen readers. Stored; the site does not show it today" }),
    avatar_url: z.string().url().nullable().openapi({ description: "Stored, not shown on the site" }),
    summary: z.array(z.string().max(1000)).max(40).nullable().openapi({
      description: "The facts under your name on the home page and /resume, one per item: where you work, what you study",
    }),
    handles: handleMap.nullable().openapi({
      description: "Usernames by site: `github`, `linkedin`, `twitter`. Shown as icons. Replaces the whole map, so send every handle you keep",
    }),
    contact: handleMap.nullable().openapi({
      description: "Contact details by name; the site shows `email`. Replaces the whole map, so send every key you keep",
    }),
  })
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

const PROFILE_COLUMNS = {
  name: "name",
  bio: "bio",
  location: "location",
  email: "email",
  website: "website",
  timezone: "timezone",
  image_url: "image_url",
  image_alt: "image_alt",
  avatar_url: "avatar_url",
  summary: "summary_json",
  handles: "handles_json",
  contact: "contact_json",
} as const;

app.patch("/profile", async (c) => {
  const patch = await body(c, profilePatchSchema);
  const existing = (await c.env.DB.prepare("SELECT * FROM profile WHERE id = 1").first<JsonRecord>()) ?? {};
  const row: JsonRecord = { ...existing };
  for (const [key, column] of Object.entries(PROFILE_COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key as keyof typeof patch];
    row[column] = column.endsWith("_json") ? (value == null ? null : JSON.stringify(value)) : (value ?? null);
  }
  const updatedAt = nowIso();
  row.updated_at = updatedAt;
  const columns = [...Object.values(PROFILE_COLUMNS), "updated_at"];
  await c.env.DB.prepare(
    `INSERT INTO profile (id, ${columns.join(", ")}) VALUES (1, ${columns.map(() => "?").join(", ")})
     ON CONFLICT(id) DO UPDATE SET ${columns.map((col) => `${col} = excluded.${col}`).join(", ")}`
  )
    .bind(...columns.map((col) => (row[col] ?? null) as string | null))
    .run();
  const saved = (await c.env.DB.prepare("SELECT * FROM profile WHERE id = 1").first<JsonRecord>()) ?? {};
  return c.json({ ok: true, updated_at: updatedAt, profile: normalizeProfile(saved) });
});

// MARK: Shelf sections

/** The seven sections of anuragd.me/shelf. The site treats a missing one as visible. */
export const SHELF_SECTIONS = ["links", "quotes", "visuals", "wallpapers", "books", "movies", "shows"] as const;

export const shelfSectionsPatchSchema = z
  .object(Object.fromEntries(SHELF_SECTIONS.map((key) => [
    key, z.boolean().openapi({ description: `true shows the ${key} section of anuragd.me/shelf, false hides it` }),
  ])) as Record<(typeof SHELF_SECTIONS)[number], z.ZodBoolean>)
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "At least one section must be provided" });

/** What GET /v1/settings answers before a settings row exists; kept identical. */
const DEFAULT_SHELF_CONFIG = {
  sections: {
    links: { visible: true },
    quotes: { visible: true },
    visuals: { visible: false },
    wallpapers: { visible: false },
  },
  hiddenItems: [],
};

app.patch("/shelf-sections", async (c) => {
  const patch = await body(c, shelfSectionsPatchSchema);
  const row = await c.env.DB.prepare("SELECT * FROM settings WHERE id = 1").first<JsonRecord>();
  const stored = row ? parseStoredJson(row.shelf_config_json) : structuredClone(DEFAULT_SHELF_CONFIG);
  // Keep everything else in the config (hiddenItems, future keys) exactly as it was.
  const config: JsonRecord = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as JsonRecord) } : {};
  const current = config.sections;
  const sections: JsonRecord = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as JsonRecord) } : {};
  for (const [key, visible] of Object.entries(patch)) {
    const previous = sections[key];
    sections[key] = { ...(previous && typeof previous === "object" ? (previous as JsonRecord) : {}), visible };
  }
  config.sections = sections;

  const updatedAt = nowIso();
  if (row) {
    await c.env.DB.prepare("UPDATE settings SET shelf_config_json = ?, updated_at = ? WHERE id = 1")
      .bind(JSON.stringify(config), updatedAt)
      .run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO settings (id, public_fields_json, theme, flags_json, shelf_config_json, updated_at) VALUES (1, ?, NULL, ?, ?, ?)"
    )
      .bind("[]", "{}", JSON.stringify(config), updatedAt)
      .run();
  }
  return c.json({ ok: true, updated_at: updatedAt, shelf_config: config });
});

// MARK: OpenAPI

const TAG = "Site";
apiTags.push({
  name: TAG,
  description: `The owner's controls for what anuragd.me shows: small writes that change only what you send. The app's Site space uses them.

**Profile.** PATCH /v1/site/profile changes the profile fields you send and keeps the rest; null clears a field. Unknown keys \
are refused (400). \`handles\` and \`contact\` replace their whole map, so GET /v1/profile first and send every key you keep. \
The reply has the saved profile. The site shows it on the home page and /resume (see the Profile guide for which fields).

**Shelf sections.** PATCH /v1/site/shelf-sections shows (true) or hides (false) sections of anuragd.me/shelf: links, quotes, \
visuals, wallpapers, books, movies and shows. Only the sections you send change; the rest of the stored shelf config is kept. \
Hiding a section doesn't touch its items.

**Uploads.** None. \`image_url\` is stored as given.

**Ask first.** Everything here is public, and there is no draft: a change is live on anuragd.me within seconds. Agents must not \
send these on their own. Show the owner the exact change, get a yes, then confirm a second time before sending it.`,
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/site/profile",
  tags: [TAG],
  summary: "Change some profile fields, keeping the rest",
  description: "Every field is optional; null clears it. Unknown keys are rejected.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(profilePatchSchema) },
  responses: structuredOkResponses(z.object({
    ok: z.boolean(),
    updated_at: dateTimeSchema,
    profile: profileResponseSchema,
  })),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/site/shelf-sections",
  tags: [TAG],
  summary: "Show or hide sections of anuragd.me/shelf",
  description: "Other keys in the stored shelf config (hiddenItems, future keys) are kept as they were.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfSectionsPatchSchema) },
  responses: structuredOkResponses(z.object({
    ok: z.boolean(),
    updated_at: dateTimeSchema,
    shelf_config: shelfConfigResponseSchema,
  })),
});

export default app;
