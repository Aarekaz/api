import { Hono } from "hono";
import type { Env } from "../types/env";
import { nowIso } from "../utils/date";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { describedFields, usesItemSchema } from "../schemas/content";
import { usesResponseSchema } from "../schemas/responses";
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

const usesPatchSchema = usesItemSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
const TAG = "Uses";
apiTags.push({
  name: TAG,
  description: `The owner's gear and software, on anuragd.me/uses, grouped by \`category\`.

**Public or private.** An item with \`published: true\` is on the site. \`published\` defaults to **true** when it is left \
out, on POST and on PUT, so always send \`published: false\`. Agents add items hidden. Only the owner puts one on the \
site, after a two-step confirm: show the item as it will appear, get a yes, then confirm once more.

**Reading.** GET /v1/uses and GET /v1/uses/{id} return published items only; add \`include_unpublished=1\` to see hidden \
ones. The website's token may only call GET /v1/uses, without that flag.

**Order of calls.** 1. GET /v1/uses?include_unpublished=1 to see the categories in use and check the item isn't there. \
2. POST /v1/uses with \`published: false\`, reusing an existing category's exact spelling. The reply has no id: find it \
with GET /v1/uses?include_unpublished=1&search=<name>.

**Uploads.** None. Items have no images.

**Avoid.** PUT replaces every field, and a PUT without \`published\` publishes the item: use PATCH with only the fields \
you change. DELETE removes the item for good.`,
});
// The request body with its field notes (usesItemSchema is also the base of the uses response, so the notes live here).
const usesBodyDoc = describedFields(usesItemSchema, {
  category: "The group it is listed under on the site. Reuse an existing category's exact spelling",
  name: "The product's name, as its maker writes it",
  url: "The product's page. Optional",
  note: "A short line on what it is used for, in the owner's words",
  published: "true puts the item on anuragd.me. Defaults to true when left out: agents always send false. Only the owner publishes",
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/uses",
  tags: [TAG],
  summary: "List uses items",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(usesResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/uses/{id}",
  tags: [TAG],
  summary: "Get uses item",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/uses",
  tags: [TAG],
  summary: "Create uses item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(usesBodyDoc) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/uses/{id}",
  tags: [TAG],
  summary: "Update uses item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(usesBodyDoc) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/uses/{id}",
  tags: [TAG],
  summary: "Patch uses item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(usesBodyDoc.partial()) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/uses/{id}",
  tags: [TAG],
  summary: "Delete uses item",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["category", "name", "note"]);
  addDateRangeFilter(filters, "created_at", start, end);
  addPublishedFilter(filters, query);

  const orderBy = parseSort(
    sort,
    { category: "category", name: "name", created_at: "created_at" },
    "category ASC, name ASC"
  );

  const sql = `SELECT * FROM uses_items${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
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

  const row = await c.env.DB.prepare(`SELECT * FROM uses_items${buildWhereClause(filters)}`)
    .bind(...filters.params)
    .all();

  if (!row.results || row.results.length === 0) {
    return notFound(c, "Uses item");
  }

  return c.json(row.results[0]);
});

app.post("/", async (c) => {
  const validation = await readBody(c, usesItemSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO uses_items (category, name, url, note, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.category,
      validation.data.name,
      validation.data.url ?? null,
      validation.data.note ?? null,
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

  const validation = await readBody(c, usesItemSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE uses_items
     SET category = ?, name = ?, url = ?, note = ?, published = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.category,
      validation.data.name,
      validation.data.url ?? null,
      validation.data.note ?? null,
      validation.data.published === false ? 0 : 1,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Uses item");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, usesPatchSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const { sets: updates, params } = patchAssignments(validation.data, {
    category: true,
    name: true,
    url: true,
    note: true,
    published: { to: publishedFlag },
  });

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE uses_items SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return notFound(c, "Uses item");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const result = await c.env.DB.prepare("DELETE FROM uses_items WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Uses item");
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
