import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeShelfItem } from "../utils/normalizers";
import { shelfItemSchema } from "../schemas/content";
import {
  openApiRegistry,
  genericArraySchema,
  okDateAddedSchema,
  openApiJsonRequestBody,
  okResponses,
  createdResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI registrations
openApiRegistry.registerPath({
  method: "get",
  path: "/v1/shelf",
  summary: "List shelf items",
  security: authSecurity,
  responses: okResponses(genericArraySchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/shelf",
  summary: "Create shelf item",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(shelfItemSchema) },
  responses: createdResponses(okDateAddedSchema),
});

// Route handlers
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM shelf_items ORDER BY date_added DESC"
  ).all();
  const results = (rows.results ?? []).map((row) =>
    normalizeShelfItem(row as JsonRecord)
  );
  return c.json(results);
});

app.post("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(shelfItemSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const dateAdded = validation.data.date_added ?? nowIso();
  await c.env.DB.prepare(
    `INSERT INTO shelf_items (type, title, quote, author, source, url, note, image_url, drawer, tags_json, date_added)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      validation.data.type,
      validation.data.title ?? null,
      validation.data.quote ?? null,
      validation.data.author ?? null,
      validation.data.source ?? null,
      validation.data.url ?? null,
      validation.data.note ?? null,
      validation.data.image_url ?? null,
      validation.data.drawer ?? null,
      mapJsonField(validation.data.tags),
      dateAdded
    )
    .run();

  return c.json({ ok: true, date_added: dateAdded }, 201);
});

export default app;
