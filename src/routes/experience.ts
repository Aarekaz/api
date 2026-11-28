import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { experienceSchema } from "../schemas/profile";
import { experiencesResponseSchema } from "../schemas/responses";
import { listQuerySchema } from "../schemas/common";
import {
  openApiRegistry,
  genericObjectSchema,
  okCreatedSchema,
  okUpdatedSchema,
  okDeletedSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
  apiTags,
} from "../schemas/openapi";
import {
  parseListQuery,
  createFilterBuilder,
  addSearchFilter,
  addDateRangeFilter,
  addPublishedFilter,
  buildWhereClause,
  parseSort,
  patchAssignments,
  publishedFlag,
} from "../utils/query";

const app = new Hono<{ Bindings: Env }>();

const experiencePatchSchema = experienceSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// OpenAPI registrations
const TAG = "Résumé";
apiTags.push({
  name: TAG,
  description: `Work history, education and skills. Public: published rows are anuragd.me/resume.

**What the site shows.** Experience: \`company\`, \`role\`, \`location\`, \`employment_type\`, the dates and \`description\`. \
Education: \`institution\`, \`degree\`, \`field\`, the dates and \`description\`. Skills: each \`category\` with its \`items\`. \
The website's token sees published rows only.

**Published by default.** The server publishes a row unless \`published\` is false, on POST and on PUT alike: a PUT that leaves \
out \`published\` publishes the row. Agents must create rows with \`published: false\`, and send \`published: false\` on any \
PUT of a hidden row (or use PATCH, which changes only the fields sent). Only the owner publishes, after a two-step confirm: \
show the row as it will read, get a yes, then confirm again. Editing a row that is already published changes the site within \
seconds, so ask the same way.

**Order of calls.** Lists and GET by id return published rows only; add \`include_unpublished=1\` to see hidden ones. To avoid \
duplicates, list with \`include_unpublished=1\` and check for the same company and role (or institution, or category) first. \
POST replies \`{ ok, created_at }\` without an id, so list again to find the new row. PATCH changes a few fields; PUT replaces \
the row. DELETE is permanent; there is no restore.

**Dates.** \`start_date\` and \`end_date\` are text. Use YYYY-MM-DD (the 1st if only the month is known): the site shows month and year. Leave \
\`end_date\` out while it's current; the site shows "Present". Lists sort by \`start_date\`, newest first.

**Uploads.** None.`,
});

// Descriptions on a copy: experienceSchema is also the base of the response schema, which stays as it is.
const experienceSchemaBody = experienceSchema.extend({
  company: experienceSchema.shape.company.openapi({ description: "The employer, as it should read on /resume" }),
  role: experienceSchema.shape.role.openapi({ description: "Your title there" }),
  location: experienceSchema.shape.location.openapi({ description: "City, or \"Remote\"" }),
  start_date: experienceSchema.shape.start_date.openapi({ description: "YYYY-MM-DD. The site shows month and year" }),
  end_date: experienceSchema.shape.end_date.openapi({ description: "YYYY-MM-DD. Leave it out while current; the site shows \"Present\"" }),
  employment_type: experienceSchema.shape.employment_type.openapi({ description: "Like \"Full-time\", \"Internship\", \"Contract\"" }),
  description: experienceSchema.shape.description.openapi({ description: "What you did there, in plain words" }),
  published: experienceSchema.shape.published.openapi({ description: "Send false. The server publishes the row unless this is false; only the owner publishes, after a two-step confirm" }),
});
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/experience",
  summary: "List experience",
  tags: [TAG],
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(experiencesResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/experience/{id}",
  summary: "Get experience",
  tags: [TAG],
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/experience",
  summary: "Create experience",
  tags: [TAG],
  security: authSecurity,
  request: { body: openApiJsonRequestBody(experienceSchemaBody) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/experience/{id}",
  summary: "Update experience",
  tags: [TAG],
  security: authSecurity,
  request: { body: openApiJsonRequestBody(experienceSchemaBody) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/experience/{id}",
  summary: "Patch experience",
  tags: [TAG],
  security: authSecurity,
  request: { body: openApiJsonRequestBody(experienceSchemaBody.partial()) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/experience/{id}",
  summary: "Delete experience",
  tags: [TAG],
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["company", "role", "location", "description"]);
  addDateRangeFilter(filters, "start_date", start, end);
  addPublishedFilter(filters, query);

  const orderBy = parseSort(
    sort,
    { start_date: "start_date", company: "company", role: "role" },
    "start_date DESC"
  );

  const sql = `SELECT * FROM experience${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...filters.params, limit, offset)
    .all();
  return c.json(rows.results ?? []);
});

app.get("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const query = c.req.query();
  const filters = createFilterBuilder();
  filters.clauses.push("id = ?");
  filters.params.push(id);
  addPublishedFilter(filters, query);

  const row = await c.env.DB.prepare(`SELECT * FROM experience${buildWhereClause(filters)}`)
    .bind(...filters.params)
    .all();

  if (!row.results || row.results.length === 0) {
    return notFound(c, "Experience");
  }

  return c.json(row.results[0]);
});

app.post("/", async (c) => {
  const validation = await readBody(c, experienceSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO experience (company, role, location, start_date, end_date, employment_type, description, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.company,
      validation.data.role,
      validation.data.location ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      validation.data.employment_type ?? null,
      validation.data.description ?? null,
      validation.data.published === false ? 0 : 1,
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

app.put("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, experienceSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE experience
     SET company = ?, role = ?, location = ?, start_date = ?, end_date = ?, employment_type = ?, description = ?, published = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.company,
      validation.data.role,
      validation.data.location ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      validation.data.employment_type ?? null,
      validation.data.description ?? null,
      validation.data.published === false ? 0 : 1,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Experience");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, experiencePatchSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const { sets: updates, params } = patchAssignments(validation.data, {
    company: true,
    role: true,
    location: true,
    start_date: true,
    end_date: true,
    employment_type: true,
    description: true,
    published: { to: publishedFlag },
  });

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE experience SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return notFound(c, "Experience");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const result = await c.env.DB.prepare("DELETE FROM experience WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Experience");
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
