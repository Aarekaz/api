import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizeProject } from "../utils/normalizers";
import { describedFields, projectSchema } from "../schemas/content";
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
  apiTags,
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
const TAG = "Projects";
apiTags.push({
  name: TAG,
  description: `The projects on anuragd.me/projects: what each one is, its links and where it is listed.

**Public or private.** A project with \`published: true\` is on the site. \`published\` defaults to **true** when it is \
left out, on POST and on PUT, so always send \`published: false\`. Agents create projects hidden. Only the owner puts one \
on the site, after a two-step confirm: show the project as it will appear, get a yes, then confirm once more. \`featured\` \
also changes the site (up to three featured projects sit at the top), so leave it to the owner too.

**Reading.** GET /v1/projects and GET /v1/projects/{id} return published projects only; add \`include_unpublished=1\` to \
see hidden ones. The website's token may only call GET /v1/projects, without that flag.

**Order of calls.** 1. Check it isn't already there: GET /v1/projects?include_unpublished=1&search=<title>. 2. POST \
/v1/projects with \`published: false\`. The reply has no id: find it with GET /v1/projects?include_unpublished=1&sort=-created_at.

**Uploads.** None. Projects have no images here.

**Avoid.** PUT replaces every field, and a PUT without \`published\` publishes the project (and resets \`featured\`, \
\`sort_order\` and \`listings\`): use PATCH with only the fields you change. Don't write \`highlight\` yourself. DELETE \
removes the project for good.`,
});
// The request body with its field notes (projectSchema is also the base of ProjectResponse, so the notes live here).
const projectBodyDoc = describedFields(projectSchema, {
  title: "The project's name",
  description: "What it is and does, in a sentence or two. Plain, no claims",
  links: "Full URLs. The site shows a GitHub link as the code link and the first other link as the demo",
  tags: "The stack and topics, short: \"typescript\", \"swift\"",
  status: "active, wip, shipped or archived. The site marks wip as in progress and dims archived",
  sort_order: "Position in the list: higher comes first. Defaults to 0",
  published: "true puts the project on anuragd.me. Defaults to true when left out: agents always send false. Only the owner publishes",
  featured: "Shown at the top of the site's list (the first three). Defaults to false. Only the owner sets it",
  highlight: "One short line under the title, up to 80 characters. Written by the owner; leave it out",
  listings: "Where the project is listed, like an app store or plugin directory: { platform, status, url }. "
    + "platform is a lowercase slug (chatgpt, poke, muse, …), one entry per platform, at most 12. status is available or "
    + "in_review; url (https) is the listing page, or null while in review",
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/projects",
  tags: [TAG],
  summary: "List projects",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(projectsResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/projects/{id}",
  tags: [TAG],
  summary: "Get project",
  security: authSecurity,
  responses: okResponses(projectResponseSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/projects",
  tags: [TAG],
  summary: "Create project",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(projectBodyDoc) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/projects/{id}",
  tags: [TAG],
  summary: "Update project",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(projectBodyDoc) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/projects/{id}",
  tags: [TAG],
  summary: "Patch project",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(projectBodyDoc.partial()) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/projects/{id}",
  tags: [TAG],
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
