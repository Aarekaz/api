import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody } from "../lib/site-http";
import { nowSchema } from "../schemas/profile";
import { nowResponseSchema } from "../schemas/responses";
import { normalizeNow } from "../utils/normalizers";
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
const TAG = "Now";
apiTags.push({
  name: TAG,
  description: `What the owner is doing these days. Public: this is anuragd.me/now.

**What the site shows.** \`focus\`, \`projects\` (each one's \`name\`, \`status\` and \`description\`), \`learning\`, \`life\`, \
\`reading_goal\` and \`last_updated\`. \`status\` and \`availability\` show in the app's Life space, not on the site; \
\`mood\` and \`current_song\` are stored but not shown anywhere on the site. The website's token reads GET /v1/now, so every \
field it returns is readable by the site.

**Order of calls.** There is one Now, and only PUT to change it. PUT replaces all of it: a field left out is cleared. So GET \
/v1/now, change what you need, and send every field back, including \`mood\` and \`current_song\` and the other keys of each \
project. Set \`last_updated\` to today as YYYY-MM-DD, as the app does.

**Uploads.** None.

**Ask first.** There is no draft: a save is live on anuragd.me/now within seconds. Agents must not change Now on their own. \
Show the owner the page as it will read, get a yes, then confirm a second time before sending it.`,
});

// Descriptions on a copy: nowSchema is also the base of the Now response schema, which stays as it is.
const nowBody = nowSchema.extend({
  focus: nowSchema.shape.focus.openapi({ description: "What you're mostly working on, a sentence. Shown on /now" }),
  status: nowSchema.shape.status.openapi({ description: "A short status line. Shown in the app's Life space, not on the site" }),
  availability: nowSchema.shape.availability.openapi({ description: "Open to work, busy and so on. Shown in the app, not on the site" }),
  mood: nowSchema.shape.mood.openapi({ description: "Stored, not shown on the site. Send back what GET returned" }),
  current_song: nowSchema.shape.current_song.openapi({ description: "Stored, not shown on the site. Send back what GET returned" }),
  learning: nowSchema.shape.learning.openapi({ description: "One thing per item. Shown on /now" }),
  projects: nowSchema.shape.projects.openapi({
    description: "What you're building: objects with `name`, `status` and `description`. Keep any other keys an item already has. Shown on /now; a `status` of \"wip\" picks the project the page's preview image names",
  }),
  life: nowSchema.shape.life.openapi({ description: "One line per item about life outside work. Shown on /now" }),
  reading_goal: nowSchema.shape.reading_goal.openapi({ description: "A short line, like \"20 books this year\". Shown on /now" }),
  last_updated: nowSchema.shape.last_updated.openapi({ description: "The day of this update, YYYY-MM-DD. Shown on /now as the date" }),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/now",
  tags: [TAG],
  summary: "Fetch current status",
  security: authSecurity,
  responses: okResponses(nowResponseSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/now",
  tags: [TAG],
  summary: "Update current status",
  description: "Replaces all of Now: every field left out is cleared. GET it first and send every field back.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(nowBody) },
  responses: okResponses(okUpdatedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM now_state WHERE id = 1").all();
  return c.json(
    row.results[0] ? normalizeNow(row.results[0] as JsonRecord) : {}
  );
});

app.put("/", async (c) => {
  const validation = await readBody(c, nowSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO now_state (id, focus, status, availability, mood, current_song, learning_json, projects_json, life_json, reading_goal, last_updated, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       focus = excluded.focus,
       status = excluded.status,
       availability = excluded.availability,
       mood = excluded.mood,
       current_song = excluded.current_song,
       learning_json = excluded.learning_json,
       projects_json = excluded.projects_json,
       life_json = excluded.life_json,
       reading_goal = excluded.reading_goal,
       last_updated = excluded.last_updated,
       updated_at = excluded.updated_at`
  )
    .bind(
      validation.data.focus ?? null,
      validation.data.status ?? null,
      validation.data.availability ?? null,
      validation.data.mood ?? null,
      validation.data.current_song ?? null,
      mapJsonField(validation.data.learning),
      mapJsonField(validation.data.projects),
      mapJsonField(validation.data.life),
      validation.data.reading_goal ?? null,
      validation.data.last_updated ?? null,
      updatedAt
    )
    .run();

  return c.json({ ok: true, updated_at: updatedAt });
});

export default app;
