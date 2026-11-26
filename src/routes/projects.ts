import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizeProject } from "../utils/normalizers";
import { projectSchema } from "../schemas/content";
import { projectResponseSchema, projectsResponseSchema } from "../schemas/responses";
import { listQuerySchema } from "../schemas/common";
import {
  openApiRegistry,
  okCreatedSchema,
  okUpdatedSchema,
  okDeletedSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";
import {
  parseListQuery,
  createFilterBuilder,
  addSearchFilter,
  addTagsFilter,
  addDateRangeFilter,
  addPublishedFilter,
  buildWhereClause,
  parseSort,
  patchAssignments,
  publishedFlag,
} from "../utils/query";

const app = new Hono<{ Bindings: Env }>();

function highlightValue(value: string | null | undefined): string | null {
  return value ? value : null;
}

const projectPatchSchema = projectSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/projects",
  summary: "List projects",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(projectsResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/projects/{id}",
  summary: "Get project",
  security: authSecurity,
  responses: okResponses(projectResponseSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/projects",
  summary: "Create project",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(projectSchema) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/projects/{id}",
  summary: "Update project",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(projectSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/projects/{id}",
  summary: "Patch project",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(projectPatchSchema) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/projects/{id}",
  summary: "Delete project",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, tags, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["title", "description", "status"]);
  addTagsFilter(filters, tags);
  addDateRangeFilter(filters, "created_at", start, end);
  addPublishedFilter(filters, query);

  const orderBy = parseSort(
    sort,
    { created_at: "created_at", updated_at: "updated_at", title: "title", sort_order: "sort_order" },
    "sort_order DESC, created_at DESC"
  );

  const sql = `SELECT * FROM projects${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...filters.params, limit, offset)
    .all();
  const results = (rows.results ?? []).map((row) =>
    normalizeProject(row as JsonRecord)
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

  const row = await c.env.DB.prepare(`SELECT * FROM projects${buildWhereClause(filters)}`)
    .bind(...filters.params)
    .all();

  if (!row.results || row.results.length === 0) {
    return notFound(c, "Project");
  }

  return c.json(normalizeProject(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const validation = await readBody(c, projectSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO projects (title, description, links_json, tags_json, status, sort_order, published, featured, highlight, listings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.title,
      validation.data.description ?? null,
      mapJsonField(validation.data.links),
      mapJsonField(validation.data.tags),
      validation.data.status ?? null,
      validation.data.sort_order ?? 0,
      validation.data.published === false ? 0 : 1,
      validation.data.featured === true ? 1 : 0,
      highlightValue(validation.data.highlight),
      mapJsonField(validation.data.listings),
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

app.put("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, projectSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE projects
     SET title = ?, description = ?, links_json = ?, tags_json = ?, status = ?, sort_order = ?, published = ?, featured = ?, highlight = ?, listings_json = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.title,
      validation.data.description ?? null,
      mapJsonField(validation.data.links),
      mapJsonField(validation.data.tags),
      validation.data.status ?? null,
      validation.data.sort_order ?? 0,
      validation.data.published === false ? 0 : 1,
      validation.data.featured === true ? 1 : 0,
      highlightValue(validation.data.highlight),
      mapJsonField(validation.data.listings),
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Project");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, projectPatchSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const { sets: updates, params } = patchAssignments(validation.data, {
    title: true,
    description: true,
    links: { column: "links_json", to: mapJsonField },
    tags: { column: "tags_json", to: mapJsonField },
    status: true,
    sort_order: { to: (value) => value ?? 0 },
    published: { to: publishedFlag },
    featured: { to: (value) => value === true ? 1 : 0 },
    highlight: { to: (value) => highlightValue(value) },
    listings: { column: "listings_json", to: mapJsonField },
  });

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE projects SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return notFound(c, "Project");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const result = await c.env.DB.prepare("DELETE FROM projects WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Project");
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
