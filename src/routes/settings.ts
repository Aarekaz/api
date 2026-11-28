import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody } from "../lib/site-http";
import { normalizeSettings } from "../utils/normalizers";
import { settingsSchema } from "../schemas/profile";
import { settingsResponseSchema } from "../schemas/responses";
import {
  openApiRegistry,
  okUpdatedSchema,
  openApiJsonRequestBody,
  okResponses,
  authSecurity,
  apiTags,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
const TAG = "Settings";
apiTags.push({
  name: TAG,
  description: `One settings record. Public: the website's token reads GET /v1/settings, so every field it returns is readable by the site.

**What the site uses.** Only \`shelf_config.sections\`: which sections of anuragd.me/shelf show. A section left out shows. \
\`public_fields\`, \`theme\` and \`flags\` are stored and returned, and the web dashboard edits them, but nothing in this API, \
the site or the app reads them.

**Order of calls.** To show or hide a shelf section, use PATCH /v1/site/shelf-sections (see the Site guide): it changes only the \
sections you send. Avoid PUT /v1/settings for that. PUT replaces the whole record, so a field left out is cleared (leaving out \
\`shelf_config\` makes every shelf section show), and its \`shelf_config.sections\` keeps only links, quotes, visuals and \
wallpapers: books, movies and shows are dropped. If you must PUT, GET first and send every field back.

**Uploads.** None.

**Ask first.** A change to \`shelf_config\` is live on anuragd.me/shelf within seconds. Agents must not change it on their own. \
Tell the owner what will show or hide, get a yes, then confirm a second time before sending it.`,
});

// Descriptions on a copy, so the request schema in schemas/profile.ts stays plain.
const sectionsShape = settingsSchema.shape.shelf_config.unwrap().shape.sections.unwrap().shape;
const shelfSection = (name: string) => ({ description: `Whether the ${name} section of anuragd.me/shelf shows` });
const settingsBody = settingsSchema.extend({
  public_fields: settingsSchema.shape.public_fields.openapi({ description: "Stored only; nothing reads it today" }),
  theme: settingsSchema.shape.theme.openapi({ description: "Stored only; nothing reads it today" }),
  flags: settingsSchema.shape.flags.openapi({ description: "Stored only; nothing reads it today" }),
  shelf_config: settingsSchema.shape.shelf_config.unwrap().extend({
    sections: settingsSchema.shape.shelf_config.unwrap().shape.sections.unwrap().extend({
      links: sectionsShape.links.openapi(shelfSection("links")),
      quotes: sectionsShape.quotes.openapi(shelfSection("quotes")),
      visuals: sectionsShape.visuals.openapi(shelfSection("visuals")),
      wallpapers: sectionsShape.wallpapers.openapi(shelfSection("wallpapers")),
    }).optional().openapi({
      description: "Only these four are kept here; books, movies and shows are dropped. Use PATCH /v1/site/shelf-sections for all seven",
    }),
    hiddenItems: settingsSchema.shape.shelf_config.unwrap().shape.hiddenItems.openapi({
      description: "Not used by the apps or the site; leave it out", deprecated: true,
    }),
  }).optional().openapi({ description: "What anuragd.me/shelf reads. Left out, it is cleared" }),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/settings",
  tags: [TAG],
  summary: "Fetch settings",
  security: authSecurity,
  responses: okResponses(settingsResponseSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/settings",
  tags: [TAG],
  summary: "Update settings",
  description: "Replaces the whole record: every field left out is cleared. To show or hide shelf sections, use PATCH /v1/site/shelf-sections.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(settingsBody) },
  responses: okResponses(okUpdatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM settings WHERE id = 1").all();
  if (!row.results[0]) {
    // Return default settings with shelf config
    return c.json({
      public_fields: [],
      theme: null,
      flags: {},
      shelf_config: {
        sections: {
          links: { visible: true },
          quotes: { visible: true },
          visuals: { visible: false },
          wallpapers: { visible: false },
        },
        hiddenItems: [],
      },
    });
  }
  return c.json(normalizeSettings(row.results[0] as JsonRecord));
});

app.put("/", async (c) => {
  const validation = await readBody(c, settingsSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO settings (id, public_fields_json, theme, flags_json, shelf_config_json, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       public_fields_json = excluded.public_fields_json,
       theme = excluded.theme,
       flags_json = excluded.flags_json,
       shelf_config_json = excluded.shelf_config_json,
       updated_at = excluded.updated_at`
  )
    .bind(
      mapJsonField(validation.data.public_fields),
      validation.data.theme ?? null,
      mapJsonField(validation.data.flags),
      mapJsonField(validation.data.shelf_config),
      updatedAt
    )
    .run();

  return c.json({ ok: true, updated_at: updatedAt });
});

export default app;
