import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types/env";
import { body, cursorFrom, appErrors, limitFrom, list, page } from "../lib/http";
import { parseJson } from "../utils/json";
import { ulid } from "../services/documents-core";
import {
  authSecurity,
  cursorQuery,
  pageFields,
  dateSchema,
  imageUploadSchema,
  okSchema,
  openApiJsonRequestBody,
  apiTags,
  openApiRegistry,
  openApiResponse,
  structuredCreatedResponses,
  structuredErrorResponses,
  structuredErrorSchema,
  structuredOkResponses,
} from "../schemas/openapi";
import { cleanIngredients, cleanSteps, extractRecipe, linkSteps, type Ingredient, type Step } from "../services/recipe-import";
import { DAY } from "../utils/date";
import { UPLOAD_KINDS, imageType } from "../services/upload-token";
import { fileExtensionForContentType } from "../utils/content-type";

// /v1/recipes: the Cookbook. Recipes saved from a link or written by hand,
// with ingredients that know their amounts (so servings scale), steps, times,
// collections, notes, and a log of every time you cooked one.
// Private: nothing here is shown on anuragd.me.

const app = appErrors(new Hono<{ Bindings: Env }>(), "Recipe request");

class RecipeError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 413 | 415 | 422 | 502, readonly code = status === 404 ? "not_found" : "invalid") { super(message); }
}

const Line = z.union([z.string().max(4000), z.object({ text: z.string().max(4000), group: z.string().max(80).nullish() })]);
// A step may say which ingredients it uses, as indexes into the ingredient list.
const StepLine = z.union([z.string().max(4000), z.object({
  text: z.string().max(4000), group: z.string().max(80).nullish(), uses: z.array(z.number().int().min(0).max(199)).max(200).nullish(),
})]);
/** The old way to mark a recipe for later; folded into want_to_cook (migration 0058). */
const WANT_TAG = "want to cook";
const Minutes = z.number().int().min(0).max(100_000).nullish();
const Url = z.string().trim().max(2000).refine((s) => /^https?:\/\//i.test(s), "must be an http(s) link");

// The descriptions are the guide agents read in /openapi.json (with the Cookbook tag's).
const Fields = {
  title: z.string().trim().min(1).max(200).openapi({ description: "The recipe's name as the source gives it" }),
  summary: z.string().max(1000).nullish().openapi({ description: "A sentence or two about the dish. Optional" }),
  source_url: Url.nullish().or(z.literal("")).openapi({
    description: "The page, video or post the recipe came from. Set it whenever there is one: it is how the recipe links back to where it was found",
  }),
  source_name: z.string().max(80).nullish().openapi({ description: "Who or where it's from, short: \"NYT Cooking\", \"@chef\"" }),
  author: z.string().max(120).nullish(),
  image_url: Url.nullish().or(z.literal("")).openapi({
    description: "A photo of the dish. Give a public image link (it is copied into this API's storage when saved), "
      + "or upload the image to POST /v1/recipes/photo and pass the url it returns",
  }),
  servings: z.number().positive().max(999).nullish().openapi({ description: "How many it serves; the app scales amounts from it" }),
  yield_text: z.string().max(80).nullish().openapi({ description: "When it makes an amount rather than portions: \"1 kg\", \"24 cookies\"" }),
  prep_minutes: Minutes.openapi({ description: "Whole minutes" }),
  cook_minutes: Minutes.openapi({ description: "Whole minutes" }),
  total_minutes: Minutes.openapi({ description: "Whole minutes" }),
  ingredients: z.array(Line).max(200).optional().openapi({
    description: "One ingredient per line, as the source writes it, amount first: \"3 tbsp + 1 tsp oil\", \"1 ½ cups (190 g) flour, sifted\". "
      + "The server reads the amount, unit and item, so don't split them yourself. "
      + "A line ending in \":\" (\"For the gravy:\") starts a group, or send { text, group }",
  }),
  steps: z.array(StepLine).max(120).optional().openapi({
    description: "One step per item, in order, as the source writes it. Don't number them (a leading \"1.\" is removed). "
      + "Keep times in the words (\"simmer for 10 minutes\", \"marinate 20–30 minutes\"): Cook mode makes its timers from them, so there is no timer field. "
      + "A short line ending in \":\" starts a group. `uses` (ingredient indexes) is optional: leave it out and the app works it out",
  }),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).optional().openapi({
    description: "Collections, like \"Weeknight\" or \"Indian\". Reuse ones from GET /v1/recipes/tags rather than making near-duplicates",
  }),
  notes: z.string().max(20_000).nullish().openapi({ description: "Your own notes: what you changed, what to try next time" }),
  favorite: z.boolean().optional().openapi({ description: "The heart: a recipe you love. The app's one save" }),
  // Migration 0058; the app went back to the heart, so nothing reads it now.
  want_to_cook: z.boolean().optional().openapi({ description: "Not used by the app; leave it out", deprecated: true }),
  // Migration 0057.
  source_text: z.string().max(20_000).nullish().openapi({
    description: "The caption, transcript or scanned page the recipe was read from, when it came from a video, post or photo rather than a recipe page",
  }),
};

const CreateRecipe = z.object(Fields);
const UpdateRecipe = z.object(Fields).partial();
const LogEntry = z.object({
  cooked_on: z.string().regex(DAY).optional(),
  rating: z.number().int().min(1).max(5).nullish(),
  note: z.string().max(2000).nullish(),
  servings: z.number().positive().max(999).nullish(),
});
// `html` is the page as the app loaded it, for sites that turn the server away.
const Import = z.object({ url: Url, html: z.string().max(5_000_000).optional() });

type Row = {
  id: string; title: string; summary: string | null; source_url: string | null; source_name: string | null; author: string | null;
  image_url: string | null; servings: number | null; yield_text: string | null; prep_minutes: number | null; cook_minutes: number | null;
  total_minutes: number | null; ingredients_json: string; steps_json: string; tags_json: string; notes: string | null; favorite: number;
  created_at: string; updated_at: string; deleted_at: string | null; source_text?: string | null; want_to_cook?: number | null;
  cooked_count?: number | null; last_cooked_on?: string | null; rating?: number | null;
};

type LogRow = { id: number; recipe_id: string; cooked_on: string; rating: number | null; note: string | null; servings: number | null; created_at: string };

const parse = <T>(s: string | null, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };

export function presentRecipe(row: Row, log?: LogRow[]) {
  return {
    id: row.id, title: row.title, summary: row.summary, source_url: row.source_url, source_name: row.source_name, author: row.author,
    image_url: row.image_url, servings: row.servings, yield_text: row.yield_text,
    prep_minutes: row.prep_minutes, cook_minutes: row.cook_minutes, total_minutes: row.total_minutes,
    ingredients: parse<Ingredient[]>(row.ingredients_json, []), steps: parse<Step[]>(row.steps_json, []),
    tags: parse<string[]>(row.tags_json, []).filter((t) => t.toLowerCase() !== WANT_TAG),
    notes: row.notes, favorite: row.favorite === 1,
    want_to_cook: row.want_to_cook === 1 || parse<string[]>(row.tags_json, []).some((t) => t.toLowerCase() === WANT_TAG),
    cooked_count: Number(row.cooked_count ?? 0), last_cooked_on: row.last_cooked_on ?? null,
    rating: row.rating === null || row.rating === undefined ? null : Math.round(Number(row.rating) * 10) / 10,
    created_at: row.created_at, updated_at: row.updated_at,
    // One recipe carries the text it was read from; lists leave it out to stay light.
    ...(log ? { source_text: row.source_text ?? null, log: log.map(presentLog) } : {}),
  };
}

const presentLog = (l: LogRow) => ({ id: l.id, recipe_id: l.recipe_id, cooked_on: l.cooked_on, rating: l.rating, note: l.note, servings: l.servings, created_at: l.created_at });

/** One error shape, { error: { code, message } } (lib/http.ts). */

// Each recipe with how often it was cooked, when last, and its average rating.
const SELECT = `SELECT r.*, (SELECT COUNT(*) FROM recipe_log l WHERE l.recipe_id = r.id) AS cooked_count,
  (SELECT MAX(cooked_on) FROM recipe_log l WHERE l.recipe_id = r.id) AS last_cooked_on,
  (SELECT AVG(rating) FROM recipe_log l WHERE l.recipe_id = r.id AND rating IS NOT NULL) AS rating FROM recipes r`;

async function load(env: Env, id: string, withLog = true) {
  const row = await env.DB.prepare(`${SELECT} WHERE r.id = ? AND r.deleted_at IS NULL`).bind(id).first<Row>();
  if (!row) throw new RecipeError("Recipe not found", 404);
  if (!withLog) return presentRecipe(row);
  const { results } = await env.DB.prepare("SELECT * FROM recipe_log WHERE recipe_id = ? ORDER BY cooked_on DESC, id DESC").bind(id).all<LogRow>();
  return presentRecipe(row, results);
}

const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const tagsOf = (list: string[]) => [...new Map(list.map((t) => [t.toLowerCase(), t.trim()])).values()];

/** Columns and values for the fields given, cleaned. */
function columns(input: z.infer<typeof UpdateRecipe>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { if (v !== undefined) out[k] = v; };
  set("title", input.title);
  set("summary", input.summary === undefined ? undefined : blank(input.summary));
  set("source_url", input.source_url === undefined ? undefined : blank(input.source_url));
  set("source_name", input.source_name === undefined ? undefined : blank(input.source_name));
  set("author", input.author === undefined ? undefined : blank(input.author));
  set("image_url", input.image_url === undefined ? undefined : blank(input.image_url));
  set("servings", input.servings === undefined ? undefined : input.servings ?? null);
  set("yield_text", input.yield_text === undefined ? undefined : blank(input.yield_text));
  set("prep_minutes", input.prep_minutes === undefined ? undefined : input.prep_minutes ?? null);
  set("cook_minutes", input.cook_minutes === undefined ? undefined : input.cook_minutes ?? null);
  set("total_minutes", input.total_minutes === undefined ? undefined : input.total_minutes ?? null);
  set("ingredients_json", input.ingredients === undefined ? undefined : JSON.stringify(cleanIngredients(input.ingredients)));
  set("steps_json", input.steps === undefined ? undefined : JSON.stringify(cleanSteps(input.steps)));
  if (input.tags !== undefined) {
    // The old "Want to cook" tag becomes the flag, not a tag.
    const tags = tagsOf(input.tags);
    if (tags.some((t) => t.toLowerCase() === WANT_TAG) && input.want_to_cook === undefined) set("want_to_cook", 1);
    set("tags_json", JSON.stringify(tags.filter((t) => t.toLowerCase() !== WANT_TAG)));
  }
  set("notes", input.notes === undefined ? undefined : blank(input.notes));
  set("favorite", input.favorite === undefined ? undefined : input.favorite ? 1 : 0);
  set("want_to_cook", input.want_to_cook === undefined ? undefined : input.want_to_cook ? 1 : 0);
  set("source_text", input.source_text === undefined ? undefined : blank(input.source_text));
  return out;
}

/** steps_json with links to missing ingredients dropped. */
const relink = (stepsJson: string, ingredientCount: number) => JSON.stringify(linkSteps(parse<Step[]>(stepsJson, []), ingredientCount));

const PAGE_HEADERS = {
  // Many recipe sites turn away anything that doesn't look like a browser.
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Keeps a copy of a recipe's photo in R2, so it survives the site changing.
 * Best effort: on any failure the original link stays.
 */
async function keepImage(env: Env, url: string | null): Promise<string | null> {
  const base = env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!url || !env.R2_BUCKET || !base || url.startsWith(base)) return url;
  try {
    const response = await fetch(url, { headers: { "User-Agent": PAGE_HEADERS["User-Agent"], Accept: "image/*" }, signal: AbortSignal.timeout(8_000) });
    const type = (response.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
    if (!response.ok || !/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) return url;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 10_000_000 || bytes.byteLength < 500) return url;
    const key = `recipes/${crypto.randomUUID()}.${type.split("/")[1].replace("jpeg", "jpg")}`;
    await env.R2_BUCKET.put(key, bytes, { httpMetadata: { contentType: type } });
    return `${base}/${key}`;
  } catch {
    return url;
  }
}

// OpenAPI registrations
const TAG = "Cookbook";
apiTags.push({
  name: TAG,
  description: `Recipes saved to keep, each linking back to where it came from. Private: nothing here is shown on anuragd.me.

**From a recipe page.** POST /v1/recipes/import { url } reads the page and returns a draft without saving it. If \`existing\` is set, \
that link is already saved: PATCH that recipe rather than saving a copy. Then POST /v1/recipes with the draft, keeping \`source_url\`. \
If the site turns the server away (502), fetch the page yourself and send it as \`html\` along with the \`url\`.

**From a video, post, photo or by hand.** POST /v1/recipes with title, ingredients and steps. Set \`source_url\` to the video or post, \
and put its caption or transcript in \`source_text\`.

**Photos.** Give every recipe a photo when the source has one. Pass a public image link as \`image_url\` (on create or update it is \
copied into this API's storage, so it survives the site changing), or POST the image bytes to /v1/recipes/photo with its \
Content-Type (image/jpeg, image/png, …) and set \`image_url\` to the url it returns. Import fills \`image_url\` from the page.

**Ingredients and steps.** Send lines as the source writes them (see the fields of POST /v1/recipes). The server reads each \
amount, so servings scale. Times written in a step become Cook mode's timers.

**Saved and cooked.** \`favorite\` is the heart. Log a cook (POST /v1/recipes/{id}/log) only when it was really cooked. \
Delete is soft: POST /v1/recipes/{id}/restore brings a recipe back.`,
});
const ingredientSchema = z.object({
  text: z.string(),
  quantity: z.number().nullable(),
  quantity_max: z.number().nullable(),
  unit: z.string().nullable(),
  item: z.string(),
  group: z.string().nullable(),
});
const stepSchema = z.object({
  text: z.string(),
  group: z.string().nullable(),
  uses: z.array(z.number().int()).optional().openapi({ description: "Indexes of the ingredients this step uses; absent when not linked" }),
});

const recipeDraftSchema = z.object({
  title: z.string(),
  summary: z.string().nullable(),
  source_url: z.string().nullable(),
  source_name: z.string().nullable(),
  author: z.string().nullable(),
  image_url: z.string().nullable(),
  servings: z.number().nullable(),
  yield_text: z.string().nullable(),
  prep_minutes: z.number().int().nullable(),
  cook_minutes: z.number().int().nullable(),
  total_minutes: z.number().int().nullable(),
  ingredients: z.array(ingredientSchema),
  steps: z.array(stepSchema),
  tags: z.array(z.string()),
});

const recipeLogSchema = z.object({
  id: z.number().int(),
  recipe_id: z.string(),
  cooked_on: dateSchema,
  rating: z.number().int().min(1).max(5).nullable(),
  note: z.string().nullable(),
  servings: z.number().nullable(),
  created_at: z.string(),
});

const recipeSchema = recipeDraftSchema.extend({
  id: z.string(),
  notes: z.string().nullable(),
  favorite: z.boolean().openapi({ description: "The heart: a recipe you love" }),
  want_to_cook: z.boolean().openapi({ description: "Not used by the app", deprecated: true }),
  cooked_count: z.number().int(),
  last_cooked_on: dateSchema.nullable(),
  rating: z.number().nullable().openapi({ description: "Average log rating, one decimal" }),
  created_at: z.string(),
  updated_at: z.string(),
});
const recipeWithLogSchema = recipeSchema.extend({
  source_text: z.string().nullable().openapi({ description: "The caption, transcript or scanned page it was read from" }),
  log: z.array(recipeLogSchema),
});
const recipeParams = z.object({ id: z.string() });

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/recipes",
  tags: [TAG],
  summary: "List recipes, most recently changed first",
  security: authSecurity,
  request: {
    query: z.object({
      q: z.string().optional(),
      tag: z.string().optional(),
      favorite: z.enum(["1"]).optional().openapi({ description: "Only hearted recipes" }),
      want: z.enum(["1"]).optional().openapi({ description: "Only want_to_cook (not used by the app)", deprecated: true }),
      limit: z.coerce.number().int().min(1).max(2000).optional().openapi({ description: "Default 1000" }),
      cursor: cursorQuery,
    }),
  },
  responses: structuredOkResponses(z.object(pageFields(recipeSchema))),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/recipes/tags",
  tags: [TAG],
  summary: "List recipe collections with how many recipes are in each",
  security: authSecurity,
  responses: structuredOkResponses(z.object({ items: z.array(z.object({ tag: z.string(), count: z.number().int() })) })),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/recipes/tags/rename",
  tags: [TAG],
  summary: "Rename a tag on every recipe that has it",
  description: "Case is ignored. If `to` is already a tag on a recipe, the two become one.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(z.object({ from: z.string(), to: z.string() })) },
  responses: structuredOkResponses(z.object({ changed: z.number().int() })),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/recipes/tags/{tag}",
  tags: [TAG],
  summary: "Take a tag off every recipe (the recipes stay)",
  security: authSecurity,
  request: { params: z.object({ tag: z.string() }) },
  responses: structuredOkResponses(z.object({ changed: z.number().int() })),
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/recipes/log",
  tags: [TAG],
  summary: "List what you cooked, newest first, across every recipe",
  security: authSecurity,
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(2000).optional().openapi({ description: "Default 200" }),
      cursor: cursorQuery,
    }),
  },
  responses: structuredOkResponses(z.object(pageFields(recipeLogSchema.extend({ title: z.string() })))),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/recipes/import",
  tags: [TAG],
  summary: "Read a recipe from a web page without saving it",
  description: "found: schema (schema.org Recipe), page (read from the markup) or basic (title and photo only). "
    + "existing is the id of a recipe already saved from that link. Send html when the site refuses the server.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(Import) },
  responses: {
    ...structuredOkResponses(z.object({
      recipe: recipeDraftSchema,
      found: z.enum(["schema", "page", "basic"]),
      existing: z.string().nullable(),
    })),
    422: openApiResponse(structuredErrorSchema, "That link isn't a web page"),
    502: openApiResponse(structuredErrorSchema, "Couldn't fetch the page"),
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/recipes/photo",
  tags: [TAG],
  summary: "Store a recipe photo (up to 15 MB) and return its link",
  security: authSecurity,
  request: {
    body: {
      description: "JPEG, PNG, WebP, HEIC, HEIF, GIF or AVIF image",
      content: { "image/*": { schema: imageUploadSchema } },
    },
  },
  responses: {
    201: openApiResponse(z.object({ url: z.string(), key: z.string() }), "Created"),
    ...structuredErrorResponses,
    413: openApiResponse(structuredErrorSchema, "Photo too large"),
    415: openApiResponse(structuredErrorSchema, "Unsupported image type"),
  },
});

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/recipes/{id}",
  tags: [TAG],
  summary: "Get a recipe with its cooking log",
  security: authSecurity,
  request: { params: recipeParams },
  responses: structuredOkResponses(recipeWithLogSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/recipes",
  tags: [TAG],
  summary: "Create recipe",
  description: "Ingredients and steps are lines (\"2 cups flour\") or { text, group }. A remote image_url is copied to R2.",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(CreateRecipe) },
  responses: structuredCreatedResponses(recipeWithLogSchema),
});

openApiRegistry.registerPath({
  method: "patch",
  path: "/v1/recipes/{id}",
  tags: [TAG],
  summary: "Update recipe (only the fields sent change)",
  security: authSecurity,
  request: { params: recipeParams, body: openApiJsonRequestBody(UpdateRecipe) },
  responses: structuredOkResponses(recipeWithLogSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/recipes/{id}",
  tags: [TAG],
  summary: "Delete recipe (soft; its log stays)",
  security: authSecurity,
  request: { params: recipeParams },
  responses: structuredOkResponses(okSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/recipes/{id}/restore",
  tags: [TAG],
  summary: "Restore a deleted recipe",
  security: authSecurity,
  request: { params: recipeParams },
  responses: structuredOkResponses(recipeWithLogSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/recipes/{id}/log",
  tags: [TAG],
  summary: "Log that you cooked a recipe",
  description: "cooked_on defaults to today (UTC). Returns the recipe.",
  security: authSecurity,
  request: { params: recipeParams, body: { ...openApiJsonRequestBody(LogEntry), required: false } },
  responses: structuredCreatedResponses(recipeWithLogSchema),
});

openApiRegistry.registerPath({
  method: "delete",
  path: "/v1/recipes/{id}/log/{logId}",
  tags: [TAG],
  summary: "Remove one line from a recipe's log",
  security: authSecurity,
  request: { params: z.object({ id: z.string(), logId: z.coerce.number().int() }) },
  responses: structuredOkResponses(recipeWithLogSchema),
});

/** GET /v1/recipes?q=&tag=&favorite=1&limit= : every recipe, most recently changed first. */
app.get("/", async (c) => {
  const where = ["r.deleted_at IS NULL"];
  const args: unknown[] = [];
  const q = c.req.query("q")?.trim();
  if (q) {
    where.push("(r.title LIKE ? OR r.ingredients_json LIKE ? OR r.tags_json LIKE ? OR r.notes LIKE ? OR r.source_name LIKE ?)");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    args.push(like, like, like, like, like);
  }
  const tag = c.req.query("tag")?.trim();
  if (tag) { where.push("EXISTS (SELECT 1 FROM json_each(r.tags_json) t WHERE lower(t.value) = lower(?))"); args.push(tag); }
  if (c.req.query("favorite") === "1") where.push("r.favorite = 1");
  if (c.req.query("want") === "1") {
    where.push("(r.want_to_cook = 1 OR EXISTS (SELECT 1 FROM json_each(r.tags_json) t WHERE lower(t.value) = ?))");
    args.push(WANT_TAG);
  }
  const after = cursorFrom(c, 2);
  if (after) { where.push("(r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))"); args.push(after[0], after[0], after[1]); }
  const limit = limitFrom(c, 1000, 2000);
  const { results } = await c.env.DB.prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`)
    .bind(...args, limit + 1).all<Row>();
  const { items, next_cursor } = page(results, limit, (r) => [r.updated_at, r.id]);
  return list(c, items.map((r) => presentRecipe(r)), next_cursor);
});

/** GET /v1/recipes/tags : collections with how many recipes are in each. */
app.get("/tags", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.value AS tag, COUNT(*) AS count FROM recipes r, json_each(r.tags_json) t
     WHERE r.deleted_at IS NULL AND lower(t.value) <> ? GROUP BY lower(t.value) ORDER BY count DESC, tag`,
  ).bind(WANT_TAG).all<{ tag: string; count: number }>();
  return c.json({ items: results.map((r) => ({ tag: r.tag, count: Number(r.count) })) });
});

/**
 * Changes one tag on every recipe that has it (case is ignored): renames it, or
 * with `to` null takes it off. The recipes themselves stay. Returns how many changed.
 */
async function retag(env: Env, from: string, to: string | null) {
  const { results } = await env.DB.prepare(
    "SELECT id, tags_json FROM recipes r WHERE deleted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(r.tags_json) t WHERE lower(t.value) = lower(?))",
  ).bind(from).all<{ id: string; tags_json: string }>();
  if (!results.length) return 0;
  const now = new Date().toISOString();
  await env.DB.batch(results.map((r) => {
    const tags = parse<string[]>(r.tags_json, []).flatMap((t) => (t.toLowerCase() === from.toLowerCase() ? (to ? [to] : []) : [t]));
    return env.DB.prepare("UPDATE recipes SET tags_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(tagsOf(tags)), now, r.id);
  }));
  return results.length;
}

const TagName = z.string().trim().min(1).max(32).refine((t) => t.toLowerCase() !== WANT_TAG, "use want_to_cook instead of this tag");
const RenameTag = z.object({ from: z.string().trim().min(1).max(32), to: TagName });

/** POST /v1/recipes/tags/rename { from, to } : renames a tag on every recipe (merging it into `to` if that exists). */
app.post("/tags/rename", async (c) => {
  const input = await body(c, RenameTag);
  return c.json({ changed: await retag(c.env, input.from, input.to) });
});

/** DELETE /v1/recipes/tags/:tag : takes a tag off every recipe. The recipes stay. */
app.delete("/tags/:tag", async (c) => {
  const tag = c.req.param("tag").trim();  // Hono has already decoded it
  if (!tag) throw new RecipeError("No tag given", 400);
  return c.json({ changed: await retag(c.env, tag, null) });
});

/** GET /v1/recipes/log?limit= : what you cooked, newest first, across every recipe. */
app.get("/log", async (c) => {
  const limit = limitFrom(c, 200, 2000);
  const after = cursorFrom(c, 2);
  const { results } = await c.env.DB.prepare(
    `SELECT l.*, r.title FROM recipe_log l JOIN recipes r ON r.id = l.recipe_id WHERE r.deleted_at IS NULL
     ${after ? "AND (l.cooked_on < ? OR (l.cooked_on = ? AND l.id < ?))" : ""}
     ORDER BY l.cooked_on DESC, l.id DESC LIMIT ?`,
  ).bind(...(after ? [after[0], after[0], after[1]] : []), limit + 1).all<LogRow & { title: string }>();
  const { items, next_cursor } = page(results, limit, (l) => [l.cooked_on, l.id]);
  return list(c, items.map((l) => ({ ...presentLog(l), title: l.title })), next_cursor);
});

/**
 * POST /v1/recipes/import { url } : reads the recipe on a page without saving it,
 * so you can look it over first. `found` says how much was read: "schema" (the
 * page's schema.org Recipe), "page" (lists read from the markup) or "basic"
 * (only the title and photo). `existing` is a recipe already saved from that link.
 * Some sites refuse servers; then the app loads the page itself and sends it as `html`.
 */
app.post("/import", async (c) => {
  const input = await body(c, Import);
  const url = input.url;
  let html = input.html, finalUrl = url;
  if (html === undefined) {
    let response: Response;
    try {
      response = await fetch(url, { headers: PAGE_HEADERS, redirect: "follow", signal: AbortSignal.timeout(12_000) });
    } catch {
      throw new RecipeError("Couldn't reach that page", 502, "fetch_failed");
    }
    if (!response.ok) throw new RecipeError(`The site answered ${response.status}`, 502, "fetch_failed");
    const type = response.headers.get("content-type") ?? "";
    if (type && !/html|xml/i.test(type)) throw new RecipeError("That link isn't a web page", 422, "not_a_page");
    html = (await response.text()).slice(0, 4_000_000);
    finalUrl = response.url || url;
  }
  const { recipe, found } = extractRecipe(html, finalUrl);
  recipe.source_url = url;
  const existing = await c.env.DB.prepare("SELECT id FROM recipes WHERE source_url = ? AND deleted_at IS NULL LIMIT 1").bind(url).first<{ id: string }>();
  return c.json({ recipe, found, existing: existing?.id ?? null });
});

/** POST /v1/recipes/photo (raw image body) : stores a photo for a recipe and returns its link. */
app.post("/photo", async (c) => {
  // The same rules as every other upload (services/upload-token.ts), in this route's error shape.
  const spec = UPLOAD_KINDS.recipe;
  const type = imageType(c.req.header("content-type"), spec.types);
  if (!type) throw new RecipeError("Send a JPEG, PNG, WebP, HEIC, GIF or AVIF image", 415);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) throw new RecipeError("No image in the request", 400);
  if (bytes.byteLength > spec.directMax) throw new RecipeError("That photo is over 15 MB", 413);
  const key = `${spec.prefix}${crypto.randomUUID()}.${fileExtensionForContentType(type)}`;
  await c.env.R2_BUCKET.put(key, bytes, { httpMetadata: { contentType: type } });
  const base = c.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
  return c.json({ url: base ? `${base}/${key}` : key, key }, 201);
});

/** GET /v1/recipes/:id : one recipe with its cooking log. */
app.get("/:id", async (c) => {
  return c.json(await load(c.env, c.req.param("id")));
});

/** POST /v1/recipes { title, ingredients: ["2 cups flour", …], steps: […], … } */
app.post("/", async (c) => {
  const input = await body(c, CreateRecipe);
  const cols = columns(input);
  if (typeof cols.steps_json === "string") cols.steps_json = relink(cols.steps_json, parse<Ingredient[]>((cols.ingredients_json as string | undefined) ?? null, []).length);
  cols.image_url = await keepImage(c.env, (cols.image_url as string | null | undefined) ?? null);
  const now = new Date().toISOString();
  const id = ulid();
  const all = { ingredients_json: "[]", steps_json: "[]", tags_json: "[]", favorite: 0, ...cols, id, created_at: now, updated_at: now };
  const keys = Object.keys(all);
  await c.env.DB.prepare(`INSERT INTO recipes (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .bind(...keys.map((k) => (all as Record<string, unknown>)[k] ?? null)).run();
  return c.json(await load(c.env, id), 201);
});

/** PATCH /v1/recipes/:id { any fields } : only what's sent changes. */
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const input = await body(c, UpdateRecipe);
  const current = await load(c.env, id, false);
  const cols = columns(input);
  // A step's links point into the ingredient list, so either changing rechecks them.
  if ("steps_json" in cols || "ingredients_json" in cols) {
    const count = "ingredients_json" in cols ? parse<Ingredient[]>(cols.ingredients_json as string, []).length : current.ingredients.length;
    cols.steps_json = relink((cols.steps_json as string | undefined) ?? JSON.stringify(current.steps), count);
  }
  if ("image_url" in cols) cols.image_url = await keepImage(c.env, (cols.image_url as string | null) ?? null);
  const keys = Object.keys(cols);
  if (keys.length) {
    await c.env.DB.prepare(`UPDATE recipes SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => cols[k] ?? null), new Date().toISOString(), id).run();
  }
  return c.json(await load(c.env, id));
});

/** DELETE /v1/recipes/:id : soft, so it can come back (POST /:id/restore). Its log stays. */
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await load(c.env, id, false);
  await c.env.DB.prepare("UPDATE recipes SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
  return c.json({ ok: true });
});

/** POST /v1/recipes/:id/restore : brings a deleted recipe back. */
app.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  const result = await c.env.DB.prepare("UPDATE recipes SET deleted_at = NULL WHERE id = ?").bind(id).run();
  if (!result.meta.changes) throw new RecipeError("Recipe not found", 404);
  return c.json(await load(c.env, id));
});

/** POST /v1/recipes/:id/log { cooked_on?, rating?, note?, servings? } : "I cooked this". Returns the recipe. */
app.post("/:id/log", async (c) => {
  const id = c.req.param("id");
  const input = LogEntry.parse((await parseJson(c.req.raw)) ?? {});
  await load(c.env, id, false);
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT INTO recipe_log (recipe_id, cooked_on, rating, note, servings, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, input.cooked_on ?? now.slice(0, 10), input.rating ?? null, blank(input.note), input.servings ?? null, now).run();
  return c.json(await load(c.env, id), 201);
});

/** DELETE /v1/recipes/:id/log/:logId : removes one line from the log. Returns the recipe. */
app.delete("/:id/log/:logId", async (c) => {
  const id = c.req.param("id");
  const result = await c.env.DB.prepare("DELETE FROM recipe_log WHERE id = ? AND recipe_id = ?").bind(Number(c.req.param("logId")), id).run();
  if (!result.meta.changes) throw new RecipeError("Log entry not found", 404);
  return c.json(await load(c.env, id));
});

export default app;
