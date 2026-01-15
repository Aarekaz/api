import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeProject } from "../utils/normalizers";
import { projectSchema } from "../schemas/content";
import { listQuerySchema } from "../schemas/common";
import {
  openApiRegistry,
  genericArraySchema,
  genericObjectSchema,
  okCreatedSchema,
  okUpdatedSchema,
  okDeletedSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  openApiResponseWithExample,
  authSecurity,
  errorResponses,
} from "../schemas/openapi";
import {
  parseListQuery,
  createFilterBuilder,
  addSearchFilter,
  addTagsFilter,
  addDateRangeFilter,
  buildWhereClause,
  parseSort,
  parseId,
} from "../utils/query";

const app = new Hono<{ Bindings: Env }>();

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
  responses: {
    200: openApiResponseWithExample(genericArraySchema, "OK", [
      {
        id: 1,
        title: "Personal API",
        description: "Cloudflare Worker + D1.",
        links: ["https://api.example.com", "https://github.com/user/repo"],
        tags: ["cloudflare", "typescript"],
        status: "active",
        created_at: "2025-01-05T12:34:56.000Z",
        updated_at: "2025-01-05T12:34:56.000Z",
      },
    ]),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/projects/{id}",
  summary: "Get project",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
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

  const orderBy = parseSort(
    sort,
    { created_at: "created_at", updated_at: "updated_at", title: "title" },
    "created_at DESC"
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
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json(normalizeProject(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(projectSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO projects (title, description, links_json, tags_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.title,
      validation.data.description ?? null,
      mapJsonField(validation.data.links),
      mapJsonField(validation.data.tags),
      validation.data.status ?? null,
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

app.put("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(projectSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE projects
     SET title = ?, description = ?, links_json = ?, tags_json = ?, status = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.title,
      validation.data.description ?? null,
      mapJsonField(validation.data.links),
      mapJsonField(validation.data.tags),
      validation.data.status ?? null,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(projectPatchSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (Object.prototype.hasOwnProperty.call(validation.data, "title")) {
    updates.push("title = ?");
    params.push(validation.data.title ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "description")) {
    updates.push("description = ?");
    params.push(validation.data.description ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "links")) {
    updates.push("links_json = ?");
    params.push(mapJsonField(validation.data.links));
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "tags")) {
    updates.push("tags_json = ?");
    params.push(mapJsonField(validation.data.tags));
  }
  if (Object.prototype.hasOwnProperty.call(validation.data, "status")) {
    updates.push("status = ?");
    params.push(validation.data.status ?? null);
  }

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE projects SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const result = await c.env.DB.prepare("DELETE FROM projects WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
