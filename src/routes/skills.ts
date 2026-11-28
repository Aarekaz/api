import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizeSkill } from "../utils/normalizers";
import { skillSchema } from "../schemas/profile";
import { skillsResponseSchema } from "../schemas/responses";
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

const skillPatchSchema = skillSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
const TAG = "Résumé"; // The guide is in routes/experience.ts.

// Descriptions on a copy: skillSchema is also the base of the response schema, which stays as it is.
const skillSchemaBody = skillSchema.extend({
  category: skillSchema.shape.category.openapi({ description: "The group name, like \"Languages\". One row per category: add to an existing category's items rather than making a second row" }),
  items: skillSchema.shape.items.openapi({ description: "The skills in this category, one per item, in the order to show. PATCH and PUT replace the whole list" }),
  published: skillSchema.shape.published.openapi({ description: "Send false. The server publishes the row unless this is false; only the owner publishes, after a two-step confirm" }),
});
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/skills",
  summary: "List skills",
  tags: [TAG],
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(skillsResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/skills/{id}",
  summary: "Get skill",
  tags: [TAG],
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/skills",
  summary: "Create skill",
  tags: [TAG],
  security: authSecurity,
  request: { body: openApiJsonRequestBody(skillSchemaBody) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/skills/{id}",
  summary: "Update skill",
  tags: [TAG],
  security: authSecurity,
  request: { body: openApiJsonRequestBody(skillSchemaBody) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/skills/{id}",
  summary: "Patch skill",
  tags: [TAG],
  security: authSecurity,
  request: { body: openApiJsonRequestBody(skillSchemaBody.partial()) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/skills/{id}",
  summary: "Delete skill",
  tags: [TAG],
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["category"]);
  addDateRangeFilter(filters, "updated_at", start, end);
  addPublishedFilter(filters, query);

  const orderBy = parseSort(
    sort,
    { category: "category", updated_at: "updated_at" },
    "category ASC"
  );

  const sql = `SELECT * FROM skills${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...filters.params, limit, offset)
    .all();
  const results = (rows.results ?? []).map((row) =>
    normalizeSkill(row as JsonRecord)
  );
  return c.json(results);
});

app.get("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const query = c.req.query();
  const filters = createFilterBuilder();
  filters.clauses.push("id = ?");
  filters.params.push(id);
  addPublishedFilter(filters, query);

  const row = await c.env.DB.prepare(`SELECT * FROM skills${buildWhereClause(filters)}`)
    .bind(...filters.params)
    .all();

  if (!row.results || row.results.length === 0) {
    return notFound(c, "Skill");
  }

  return c.json(normalizeSkill(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const validation = await readBody(c, skillSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO skills (category, items_json, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.category,
      mapJsonField(validation.data.items),
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

  const validation = await readBody(c, skillSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE skills
     SET category = ?, items_json = ?, published = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.category,
      mapJsonField(validation.data.items),
      validation.data.published === false ? 0 : 1,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Skill");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, skillPatchSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const { sets: updates, params } = patchAssignments(validation.data, {
    category: true,
    items: { column: "items_json", to: mapJsonField },
    published: { to: publishedFlag },
  });

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE skills SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return notFound(c, "Skill");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const result = await c.env.DB.prepare("DELETE FROM skills WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Skill");
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
