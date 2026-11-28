import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody } from "../lib/site-http";
import { normalizeProfile } from "../utils/normalizers";
import { profileSchema } from "../schemas/profile";
import { profileResponseSchema } from "../schemas/responses";
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
// profileSchema is also the base of the profile response schema, so field descriptions
// live on PATCH /v1/site/profile (routes/site.ts), the write to use.
const TAG = "Profile";
apiTags.push({
  name: TAG,
  description: `The owner's name, bio and links. Public: this is the top of the home page and /resume on anuragd.me.

**What the site shows.** \`name\`, \`bio\`, \`summary\` (the facts under the name, one per line), \`location\`, \`email\`, \
\`website\`, \`image_url\`, \`handles\` (github, linkedin, twitter, shown as icons) and \`contact\`. \`timezone\`, \`avatar_url\` \
and \`image_alt\` are stored and returned, but the site doesn't show them. The website's token reads GET /v1/profile, so \
every field it returns is readable by the site.

**Order of calls.** GET /v1/profile first. To change some fields, use PATCH /v1/site/profile (see the Site guide): it keeps \
the fields you leave out, and null clears one. Avoid PUT /v1/profile: it replaces the whole profile, and any field left out \
is cleared.

**Uploads.** None here. \`image_url\` is stored as given; it is not copied into this API's storage.

**Ask first.** There is no draft or published flag: a write is live on anuragd.me within seconds. Agents must not change the \
profile on their own. Show the owner the exact change, get a yes, then confirm a second time before sending it.`,
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/profile",
  tags: [TAG],
  summary: "Fetch profile",
  security: authSecurity,
  responses: okResponses(profileResponseSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/profile",
  tags: [TAG],
  summary: "Replace the whole profile",
  description: "Every field left out is cleared. To change a few fields, use PATCH /v1/site/profile instead.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(profileSchema) },
  responses: okResponses(okUpdatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM profile WHERE id = 1").all();
  return c.json(
    row.results[0] ? normalizeProfile(row.results[0] as JsonRecord) : {}
  );
});

app.put("/", async (c) => {
  const validation = await readBody(c, profileSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO profile (id, name, bio, handles_json, contact_json, timezone, avatar_url, location, email, website, image_url, image_alt, summary_json, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       bio = excluded.bio,
       handles_json = excluded.handles_json,
       contact_json = excluded.contact_json,
       timezone = excluded.timezone,
       avatar_url = excluded.avatar_url,
       location = excluded.location,
       email = excluded.email,
       website = excluded.website,
       image_url = excluded.image_url,
       image_alt = excluded.image_alt,
       summary_json = excluded.summary_json,
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
      validation.data.email ?? null,
      validation.data.website ?? null,
      validation.data.image_url ?? null,
      validation.data.image_alt ?? null,
      mapJsonField(validation.data.summary),
      updatedAt
    )
    .run();

  return c.json({ ok: true, updated_at: updatedAt });
});

export default app;
