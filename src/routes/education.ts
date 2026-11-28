import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { educationSchema } from "../schemas/profile";
import { educationListResponseSchema } from "../schemas/responses";
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

const educationPatchSchema = educationSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// OpenAPI registrations
const TAG = "Résumé"; // The guide is in routes/experience.ts.

// Descriptions on a copy: educationSchema is also the base of the response schema, which stays as it is.
const educationSchemaBody = educationSchema.extend({
  institution: educationSchema.shape.institution.openapi({ description: "The school, as it should read on /resume" }),
  degree: educationSchema.shape.degree.openapi({ description: "Like \"B.S.\"" }),
  field: educationSchema.shape.field.openapi({ description: "What you studied" }),
  start_date: educationSchema.shape.start_date.openapi({ description: "YYYY-MM-DD. The site shows month and year" }),
  end_date: educationSchema.shape.end_date.openapi({ description: "YYYY-MM-DD, the expected end if still studying. Left out, the site shows \"Present\"" }),
  description: educationSchema.shape.description.openapi({ description: "Optional notes, in plain words" }),
  published: educationSchema.shape.published.openapi({ description: "Send false. The server publishes the row unless this is false; only the owner publishes, after a two-step confirm" }),
});
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/education",
  summary: "List education",
  tags: [TAG],
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(educationListResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/education/{id}",
  summary: "Get education",
  tags: [TAG],
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/education",
  summary: "Create education",
  tags: [TAG],
  security: authSecurity,
  request: { body: openApiJsonRequestBody(educationSchemaBody) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/education/{id}",
  summary: "Update education",
  tags: [TAG],
  security: authSecurity,
  request: { body: openApiJsonRequestBody(educationSchemaBody) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/education/{id}",
  summary: "Patch education",
  tags: [TAG],
  security: authSecurity,
  request: { body: openApiJsonRequestBody(educationSchemaBody.partial()) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/education/{id}",
  summary: "Delete education",
  tags: [TAG],
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["institution", "degree", "field", "description"]);
  addDateRangeFilter(filters, "start_date", start, end);
  addPublishedFilter(filters, query);

  const orderBy = parseSort(
    sort,
    { start_date: "start_date", institution: "institution" },
    "start_date DESC"
  );

  const sql = `SELECT * FROM education${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
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

  const row = await c.env.DB.prepare(`SELECT * FROM education${buildWhereClause(filters)}`)
    .bind(...filters.params)
    .all();

  if (!row.results || row.results.length === 0) {
    return notFound(c, "Education");
  }

  return c.json(row.results[0]);
});

app.post("/", async (c) => {
  const validation = await readBody(c, educationSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO education (institution, degree, field, start_date, end_date, description, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.institution,
      validation.data.degree ?? null,
      validation.data.field ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
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

  const validation = await readBody(c, educationSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE education
     SET institution = ?, degree = ?, field = ?, start_date = ?, end_date = ?, description = ?, published = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.institution,
      validation.data.degree ?? null,
      validation.data.field ?? null,
      validation.data.start_date ?? null,
      validation.data.end_date ?? null,
      validation.data.description ?? null,
      validation.data.published === false ? 0 : 1,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Education");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, educationPatchSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const { sets: updates, params } = patchAssignments(validation.data, {
    institution: true,
    degree: true,
    field: true,
    start_date: true,
    end_date: true,
    description: true,
    published: { to: publishedFlag },
  });

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE education SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return notFound(c, "Education");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const result = await c.env.DB.prepare("DELETE FROM education WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Education");
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
