import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { mapJsonField } from "../utils/json";
import { readBody, idParam, badId, notFound } from "../lib/site-http";
import { normalizePost } from "../utils/normalizers";
import { describedFields, postSchema } from "../schemas/content";
import { postsResponseSchema } from "../schemas/responses";
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
import { isSiteCaller } from "../middleware/auth";
import {
  parseListQuery,
  createFilterBuilder,
  addSearchFilter,
  addTagsFilter,
  addDateRangeFilter,
  buildWhereClause,
  parseSort,
  patchAssignments,
} from "../utils/query";

const app = new Hono<{ Bindings: Env }>();

const postPatchSchema = postSchema.partial().refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// OpenAPI registrations
const TAG = "Posts";
apiTags.push({
  name: TAG,
  description: `Blog posts on anuragd.me/blog, written in Markdown. The apps write posts as Writing (see the Inbox guide): \
a document with \`kind\` writing, which POST /v1/documents/{id}/publish copies here. Prefer that for a new piece. These \
routes are the posts table itself.

**Draft or published.** There is no \`published\` flag to send. A post with no \`published_at\` is a draft; setting \
\`published_at\` puts it on the site (the \`published\` in replies is worked out from it). The website's token lists only \
posts with a \`published_at\`; the owner's token lists drafts too. Agents only write drafts: leave \`published_at\` out. \
Only the owner publishes, after a two-step confirm: show the post as it will appear, get a yes, then confirm once more.

**Order of calls.** 1. Check the slug is free: GET /v1/posts?search=<slug> (slugs are unique; a taken one fails). \
2. Upload any images (below) and put them in \`content\` as \`![alt](url)\`. 3. POST /v1/posts. The reply has no id: find \
the post with GET /v1/posts?search=<slug>.

**Images.** Blog images go to /v1/blog-images, not /v1/photos (Photography) or /v1/documents/photos. POST the bytes to \
/v1/blog-images/upload with the Content-Type (image/png, image/jpeg or image/webp) and a Content-Length, up to 5 MB. For \
bigger files, POST /v1/blog-images/presign (X-Content-Type, default image/png), then PUT the bytes to the \`uploadUrl\` \
with the X-Upload-Token header, up to 25 MB; the token lasts 5 minutes and stores one file. Use the \`url\` in the reply. \
Blog images go straight to the public media bucket, so the file is public as soon as it is uploaded, even while the post is \
a draft. Don't upload anything private there. There is no delete route for them.

**Avoid.** PUT replaces every field: a PUT without \`published_at\` takes a live post off the site. Use PATCH with only the \
fields you change. Don't edit a published post unless the owner asks: the change is live at once. DELETE removes the post \
for good (a Writing document that was published keeps pointing at it).`,
});
// The request body with its field notes (postSchema is also the base of PostResponse, so the notes live here).
const postBodyDoc = describedFields(postSchema, {
  slug: "The URL name: anuragd.me/blog/<slug>. Lowercase words joined by hyphens. Unique",
  title: "The post's title. The site shows it above the content, so don't repeat it as a `# heading` in `content`",
  summary: "One or two sentences for the blog list and link previews",
  content: "The post in Markdown (GitHub style). Images as `![alt](url)` with urls from /v1/blog-images",
  tags: "Topics, short and lowercase",
  published_at: "When it went live (ISO 8601). Setting it publishes the post; leaving it out keeps a draft. Only the owner sets it",
  pinned: { description: "Not used by the apps or the site; leave it out", deprecated: true },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/posts",
  tags: [TAG],
  summary: "List posts",
  security: authSecurity,
  request: { query: listQuerySchema },
  responses: okResponses(postsResponseSchema),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/posts/{id}",
  tags: [TAG],
  summary: "Get post",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/posts",
  tags: [TAG],
  summary: "Create post",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(postBodyDoc) },
  responses: createdResponses(okCreatedSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/posts/{id}",
  tags: [TAG],
  summary: "Update post",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(postBodyDoc) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/posts/{id}",
  tags: [TAG],
  summary: "Patch post",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(postBodyDoc.partial()) },
  responses: okResponses(okUpdatedSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/posts/{id}",
  tags: [TAG],
  summary: "Delete post",
  security: authSecurity,
  responses: okResponses(okDeletedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const query = c.req.query();
  const { limit, offset, search, sort, tags, start, end } = parseListQuery(query);
  const filters = createFilterBuilder();

  addSearchFilter(filters, search, ["slug", "title", "summary", "content"]);
  addTagsFilter(filters, tags);
  addDateRangeFilter(filters, "published_at", start, end);
  // The website's token never sees a draft (a post with no published_at).
  if (isSiteCaller(c)) filters.clauses.push("published_at IS NOT NULL");

  const orderBy = parseSort(
    sort,
    {
      published_at: "published_at",
      updated_at: "updated_at",
      title: "title",
      slug: "slug",
    },
    "published_at DESC, updated_at DESC"
  );

  const sql = `SELECT * FROM posts${buildWhereClause(filters)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...filters.params, limit, offset)
    .all();
  const results = (rows.results ?? []).map((row) =>
    normalizePost(row as JsonRecord)
  );
  return c.json(results);
});

app.get("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const row = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?")
    .bind(id)
    .all();

  if (!row.results || row.results.length === 0) {
    return notFound(c, "Post");
  }

  return c.json(normalizePost(row.results[0] as JsonRecord));
});

app.post("/", async (c) => {
  const validation = await readBody(c, postSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const createdAt = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO posts (slug, title, summary, content, tags_json, published_at, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.slug,
      validation.data.title,
      validation.data.summary ?? null,
      validation.data.content ?? null,
      mapJsonField(validation.data.tags),
      validation.data.published_at ?? null,
      validation.data.pinned ? 1 : 0,
      createdAt,
      createdAt
    )
    .run();

  return c.json({ ok: true, created_at: createdAt }, 201);
});

app.put("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, postSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const updatedAt = nowIso();
  const result = await c.env.DB.prepare(
    `UPDATE posts
     SET slug = ?, title = ?, summary = ?, content = ?, tags_json = ?, published_at = ?, pinned = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      validation.data.slug,
      validation.data.title,
      validation.data.summary ?? null,
      validation.data.content ?? null,
      mapJsonField(validation.data.tags),
      validation.data.published_at ?? null,
      validation.data.pinned ? 1 : 0,
      updatedAt,
      id
    )
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Post");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.patch("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const validation = await readBody(c, postPatchSchema);
  if (!validation.ok) {
    return validation.response;
  }

  const { sets: updates, params } = patchAssignments(validation.data, {
    slug: true,
    title: true,
    summary: true,
    content: true,
    tags: { column: "tags_json", to: mapJsonField },
    published_at: true,
    pinned: { to: (value) => value ? 1 : 0 },
  });

  const updatedAt = nowIso();
  updates.push("updated_at = ?");
  params.push(updatedAt);

  const sql = `UPDATE posts SET ${updates.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = await c.env.DB.prepare(sql).bind(...params).run();

  if (result.meta.changes === 0) {
    return notFound(c, "Post");
  }

  return c.json({ ok: true, updated_at: updatedAt });
});

app.delete("/:id", async (c) => {
  const id = idParam(c);
  if (!id) return badId(c);

  const result = await c.env.DB.prepare("DELETE FROM posts WHERE id = ?")
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return notFound(c, "Post");
  }

  return c.json({ ok: true, id, deleted_at: nowIso() });
});

export default app;
