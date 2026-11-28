// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readFileSync } from "node:fs";
import { testD1 } from "../helpers/d1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types/env";
import recipesRoute from "../../routes/recipes";
import { cleanIngredients, cleanSteps, extractRecipe, parseDuration, parseIngredient, parseYield } from "../../services/recipe-import";

/** A real SQLite database behind the subset of the D1 API the code uses (as in documents.test.ts). */
function d1(): D1Database {
  const { db, DB } = testD1();
  db.exec(readFileSync("migrations/0034_recipes.sql", "utf8"));
  db.exec(readFileSync("migrations/0057_recipe_source_text.sql", "utf8"));
  db.exec(readFileSync("migrations/0058_recipe_want_to_cook.sql", "utf8"));
  return DB;
}

function app() {
  const root = new Hono<{ Bindings: Env }>();
  root.route("/v1/recipes", recipesRoute);
  return root;
}

const send = (method: string, body?: unknown) => ({ method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });

type Recipe = {
  id: string; title: string; servings: number | null; favorite: boolean; tags: string[]; image_url: string | null;
  ingredients: Array<{ text: string; quantity: number | null; unit: string | null; item: string; group: string | null }>;
  steps: Array<{ text: string; group: string | null; uses?: number[] }>;
  cooked_count: number; last_cooked_on: string | null; rating: number | null;
  log?: Array<{ id: number; cooked_on: string; rating: number | null; note: string | null }>;
};

afterEach(() => vi.unstubAllGlobals());

describe("reading ingredients", () => {
  it("reads amounts, fractions, ranges and units", () => {
    expect(parseIngredient("2 cups all-purpose flour")).toMatchObject({ quantity: 2, unit: "cups", item: "all-purpose flour" });
    expect(parseIngredient("1 ½ tsp. salt")).toMatchObject({ quantity: 1.5, unit: "tsp", item: "salt" });
    expect(parseIngredient("1½ cups milk")).toMatchObject({ quantity: 1.5, unit: "cups" });
    expect(parseIngredient("3/4 cup sugar")).toMatchObject({ quantity: 0.75, unit: "cup" });
    expect(parseIngredient("2-3 cloves garlic, minced")).toMatchObject({ quantity: 2, quantity_max: 3, unit: "cloves", item: "garlic, minced" });
    expect(parseIngredient("1 T olive oil")).toMatchObject({ unit: "T" });
    expect(parseIngredient("1 tomato")).toMatchObject({ quantity: 1, unit: null, item: "tomato" });
    expect(parseIngredient("200g butter")).toMatchObject({ quantity: 200, unit: "g", item: "butter" });
    expect(parseIngredient("Salt, to taste")).toMatchObject({ quantity: null, unit: null, item: "Salt, to taste" });
    expect(parseIngredient("1 cup onion ((fine chopped))").item).toBe("onion (fine chopped)");
    expect(parseIngredient("1 garlic bulb")).toMatchObject({ unit: null, item: "garlic bulb" });  // "g" must be a whole word
  });

  it("adds a second amount in the same measure: 3 tbsp + 1 tsp", () => {
    expect(parseIngredient("3 tbsp + 1 tsp ginger-garlic paste")).toMatchObject({ quantity: 3.333, unit: "tbsp", item: "ginger-garlic paste" });
    expect(parseIngredient("1 cup + 2 tbsp milk")).toMatchObject({ quantity: 1.125, unit: "cup", item: "milk" });
    expect(parseIngredient("1 kg + 200 g chicken")).toMatchObject({ quantity: 1.2, unit: "kg", item: "chicken" });
    // Different kinds of measure stay as written.
    expect(parseIngredient("1 cup + 50 g sugar")).toMatchObject({ quantity: 1, unit: "cup", item: "+ 50 g sugar" });
  });

  it("keeps a step's ingredient links, deduplicated and in order", () => {
    expect(cleanSteps([{ text: "Marinate.", uses: [3, 1, 1, 0] }, "Cook.", { text: "Rest.", uses: [] }]))
      .toEqual([{ text: "Marinate.", group: null, uses: [0, 1, 3] }, { text: "Cook.", group: null }, { text: "Rest.", group: null, uses: [] }]);
  });

  it("folds heading lines into groups", () => {
    const list = cleanIngredients(["For the dough:", "2 cups flour", "For the filling:", "1 apple", { text: "1 egg", group: "Wash" }]);
    expect(list.map((i) => [i.item, i.group])).toEqual([["flour", "For the dough"], ["apple", "For the filling"], ["egg", "Wash"]]);
    expect(cleanSteps(["Dough:", "1. Mix it.", "Bake 20 minutes."]).map((s) => [s.text, s.group])).toEqual([["Mix it.", "Dough"], ["Bake 20 minutes.", "Dough"]]);
  });

  it("reads durations and yields", () => {
    expect(parseDuration("PT1H30M")).toBe(90);
    expect(parseDuration("P0DT0H20M")).toBe(20);
    expect(parseDuration("PT0S")).toBeNull();
    expect(parseDuration("1 hour 10 mins")).toBe(70);
    expect(parseYield(["4", "4 servings"])).toEqual({ servings: 4, yield_text: null });
    expect(parseYield("12 cookies")).toEqual({ servings: 12, yield_text: "12 cookies" });
    expect(parseYield("Serves 4-6")).toEqual({ servings: 4, yield_text: null });
  });
});

const SCHEMA_PAGE = `<html><head>
<meta property="og:site_name" content="Test Kitchen">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"x"},
{"@type":["Recipe"],"name":"Weeknight Dal &amp; Rice","description":"Quick and warm.","image":[{"@type":"ImageObject","url":"/img/small.jpg","width":300},{"@type":"ImageObject","url":"/img/big.jpg","width":1200}],
"author":{"@type":"Person","name":"A. Cook"},"recipeYield":["4","4 servings"],"prepTime":"PT10M","cookTime":"PT30M",
"recipeIngredient":["1 cup red lentils","3 cups water","1 tsp turmeric"],
"recipeCategory":"Dinner","recipeCuisine":["Indian"],
"recipeInstructions":[{"@type":"HowToSection","name":"Dal","itemListElement":[{"@type":"HowToStep","text":"Rinse the lentils."},{"@type":"HowToStep","text":"Simmer for 25 minutes."}]},{"@type":"HowToStep","text":"Serve with rice."}]}]}
</script></head><body></body></html>`;

describe("reading a recipe page", () => {
  it("reads schema.org Recipe JSON-LD", () => {
    const { recipe, found } = extractRecipe(SCHEMA_PAGE, "https://example.com/dal");
    expect(found).toBe("schema");
    expect(recipe).toMatchObject({
      title: "Weeknight Dal & Rice", author: "A. Cook", source_name: "Test Kitchen", servings: 4,
      prep_minutes: 10, cook_minutes: 30, total_minutes: 40, image_url: "https://example.com/img/big.jpg", tags: ["Dinner", "Indian"],
    });
    expect(recipe.ingredients[0]).toMatchObject({ quantity: 1, unit: "cup", item: "red lentils" });
    expect(recipe.steps).toEqual([
      { text: "Rinse the lentils.", group: "Dal" }, { text: "Simmer for 25 minutes.", group: "Dal" }, { text: "Serve with rice.", group: null },
    ]);
  });

  it("falls back to the page's markup", () => {
    const html = `<html><head><meta property="og:title" content="Toast"><meta property="og:image" content="https://example.com/t.jpg"></head><body>
      <ul><li class="wprm-recipe-ingredient">2 slices bread</li><li class="wprm-recipe-ingredient">1 tbsp butter</li></ul>
      <ol><li class="instruction">Toast the bread.</li><li class="instruction">Butter it.</li></ol></body></html>`;
    const { recipe, found } = extractRecipe(html, "https://example.com/toast");
    expect(found).toBe("page");
    expect(recipe.title).toBe("Toast");
    expect(recipe.ingredients.map((i) => i.unit)).toEqual(["slices", "tbsp"]);
    expect(recipe.steps.map((s) => s.text)).toEqual(["Toast the bread.", "Butter it."]);
  });

  it("returns the basics when there's no recipe", () => {
    const { recipe, found } = extractRecipe("<html><head><title>Hello</title></head><body><p>Hi</p></body></html>", "https://example.com/");
    expect(found).toBe("basic");
    expect(recipe.title).toBe("Hello");
  });
});

describe("recipes routes", () => {
  it("creates, lists, searches, updates and soft-deletes", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const res = await root.request("/v1/recipes", send("POST", {
      title: "Pancakes", servings: 2, ingredients: ["1 cup flour", "1 egg", "Batter extras:", "1 tbsp sugar"], steps: ["Mix.", "Cook 2 minutes a side."],
      tags: ["Breakfast", "breakfast", "Quick"],
    }), env);
    expect(res.status).toBe(201);
    const created = await res.json() as Recipe;
    expect(created.ingredients[2]).toMatchObject({ quantity: 1, unit: "tbsp", item: "sugar", group: "Batter extras" });
    expect(created.tags).toEqual(["breakfast", "Quick"]);
    expect(created.log).toEqual([]);

    await root.request("/v1/recipes", send("POST", { title: "Dal", ingredients: ["1 cup lentils"], tags: ["Dinner"] }), env);
    const all = await (await root.request("/v1/recipes", {}, env)).json() as { items: Recipe[] };
    expect(all.items).toHaveLength(2);
    const found = await (await root.request("/v1/recipes?q=lentil", {}, env)).json() as { items: Recipe[] };
    expect(found.items.map((r) => r.title)).toEqual(["Dal"]);
    const tagged = await (await root.request("/v1/recipes?tag=QUICK", {}, env)).json() as { items: Recipe[] };
    expect(tagged.items.map((r) => r.title)).toEqual(["Pancakes"]);
    const tags = await (await root.request("/v1/recipes/tags", {}, env)).json() as { items: Array<{ tag: string; count: number }> };
    expect(tags.items.map((t) => t.tag).sort()).toEqual(["Dinner", "Quick", "breakfast"].sort());

    const patched = await (await root.request(`/v1/recipes/${created.id}`, send("PATCH", { favorite: true, servings: 4 }), env)).json() as Recipe;
    expect(patched).toMatchObject({ favorite: true, servings: 4, title: "Pancakes" });
    expect(patched.ingredients).toHaveLength(3);
    const faves = await (await root.request("/v1/recipes?favorite=1", {}, env)).json() as { items: Recipe[] };
    expect(faves.items.map((r) => r.id)).toEqual([created.id]);

    expect((await root.request(`/v1/recipes/${created.id}`, send("DELETE"), env)).status).toBe(200);
    expect((await root.request(`/v1/recipes/${created.id}`, {}, env)).status).toBe(404);
    expect(((await (await root.request("/v1/recipes", {}, env)).json()) as { items: Recipe[] }).items).toHaveLength(1);
    const back = await root.request(`/v1/recipes/${created.id}/restore`, send("POST"), env);
    expect(((await back.json()) as Recipe).title).toBe("Pancakes");
  });

  it("keeps the text a recipe was read from, on the recipe but not in the list", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const created = await (await root.request("/v1/recipes", send("POST", { title: "Chukauni", ingredients: ["Potatoes"] }), env)).json() as Recipe & { source_text: string | null };
    expect(created.source_text).toBeNull();
    // The amounts review saves the lines with amounts and the caption they came from.
    const caption = "Boil 4 potatoes, add 1 cup curd and 2 tbsp mustard oil.";
    const patched = await (await root.request(`/v1/recipes/${created.id}`, send("PATCH", {
      ingredients: [{ text: "4 Potatoes", group: null }], source_text: caption,
    }), env)).json() as Recipe & { source_text: string | null };
    expect(patched.source_text).toBe(caption);
    expect(patched.ingredients[0]).toMatchObject({ quantity: 4, item: "Potatoes" });
    const one = await (await root.request(`/v1/recipes/${created.id}`, {}, env)).json() as { source_text: string | null };
    expect(one.source_text).toBe(caption);
    const all = await (await root.request("/v1/recipes", {}, env)).json() as { items: Array<Record<string, unknown>> };
    expect(all.items[0]).not.toHaveProperty("source_text");
    // A PATCH without it leaves it; an empty one clears it.
    await root.request(`/v1/recipes/${created.id}`, send("PATCH", { favorite: true }), env);
    expect(((await (await root.request(`/v1/recipes/${created.id}`, {}, env)).json()) as { source_text: string | null }).source_text).toBe(caption);
    const cleared = await (await root.request(`/v1/recipes/${created.id}`, send("PATCH", { source_text: "  " }), env)).json() as { source_text: string | null };
    expect(cleared.source_text).toBeNull();
    expect((await root.request(`/v1/recipes/${created.id}`, send("PATCH", { source_text: "x".repeat(20_001) }), env)).status).toBe(400);
  });

  it("logs cooking with ratings", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const recipe = await (await root.request("/v1/recipes", send("POST", { title: "Soup" }), env)).json() as Recipe;
    await root.request(`/v1/recipes/${recipe.id}/log`, send("POST", { cooked_on: "2026-11-01", rating: 4 }), env);
    const after = await (await root.request(`/v1/recipes/${recipe.id}/log`, send("POST", { cooked_on: "2026-11-20", rating: 5, note: "More salt" }), env)).json() as Recipe;
    expect(after).toMatchObject({ cooked_count: 2, last_cooked_on: "2026-11-20", rating: 4.5 });
    expect(after.log?.map((l) => l.cooked_on)).toEqual(["2026-11-20", "2026-11-01"]);
    const log = await (await root.request("/v1/recipes/log", {}, env)).json() as { items: Array<{ title: string }> };
    expect(log.items[0].title).toBe("Soup");
    const removed = await (await root.request(`/v1/recipes/${recipe.id}/log/${after.log![1].id}`, send("DELETE"), env)).json() as Recipe;
    expect(removed.cooked_count).toBe(1);
  });

  it("answers errors in one shape", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const bad = await root.request("/v1/recipes", send("POST", { title: "" }), env);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid");
    const missing = await root.request("/v1/recipes/nope", {}, env);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "Recipe not found" } });
    const badRating = await root.request("/v1/recipes/nope/log", send("POST", { rating: 9 }), env);
    expect(badRating.status).toBe(400);
  });

  it("imports a page without saving it", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SCHEMA_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })));
    const res = await root.request("/v1/recipes/import", send("POST", { url: "https://example.com/dal" }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { recipe: { title: string; ingredients: unknown[] }; found: string; existing: string | null };
    expect(body).toMatchObject({ found: "schema", existing: null });
    expect(body.recipe.title).toBe("Weeknight Dal & Rice");
    const all = await (await root.request("/v1/recipes", {}, env)).json() as { items: Recipe[] };
    expect(all.items).toHaveLength(0);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const blocked = await root.request("/v1/recipes/import", send("POST", { url: "https://example.com/x" }), env);
    expect(blocked.status).toBe(502);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("fetch_failed");
    // The app can send the page it loaded itself when a site turns the server away.
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const sent = await (await root.request("/v1/recipes/import", send("POST", { url: "https://example.com/x", html: SCHEMA_PAGE }), env)).json() as { found: string; recipe: { source_url: string } };
    expect(sent).toMatchObject({ found: "schema", recipe: { source_url: "https://example.com/x" } });
    expect(fetched).not.toHaveBeenCalled();
    const notUrl = await root.request("/v1/recipes/import", send("POST", { url: "ftp://x" }), env);
    expect(notUrl.status).toBe(400);
  });

  it("keeps a copy of an imported photo in R2", async () => {
    const stored: string[] = [];
    const env = {
      DB: d1(), R2_PUBLIC_BASE_URL: "https://media.example.com",
      R2_BUCKET: { put: async (key: string) => { stored.push(key); } },
    } as unknown as Env;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(2000), { headers: { "content-type": "image/jpeg" } })));
    const recipe = await (await app().request("/v1/recipes", send("POST", { title: "Cake", image_url: "https://site.example/cake.jpg" }), env)).json() as Recipe;
    expect(stored).toHaveLength(1);
    expect(recipe.image_url).toBe(`https://media.example.com/${stored[0]}`);
  });

  it("keeps one save, Want to Cook, and folds the old tag and heart into it", async () => {
    const { db, DB } = testD1();
    db.exec(readFileSync("migrations/0034_recipes.sql", "utf8"));
    db.exec(readFileSync("migrations/0057_recipe_source_text.sql", "utf8"));
    const now = "2026-11-01T00:00:00.000Z";
    db.exec(`INSERT INTO recipes (id, title, tags_json, favorite, created_at, updated_at) VALUES
      ('a', 'Hearted', '[]', 1, '${now}', '${now}'), ('b', 'Tagged', '["Want to cook","Curry"]', 0, '${now}', '${now}'), ('c', 'Plain', '[]', 0, '${now}', '${now}')`);
    db.exec(readFileSync("migrations/0058_recipe_want_to_cook.sql", "utf8"));
    const env = { DB } as Env;
    const root = app();
    const list = await (await root.request("/v1/recipes?want=1", {}, env)).json() as { items: Array<Recipe & { want_to_cook: boolean }> };
    expect(list.items.map((r) => r.id).sort()).toEqual(["a", "b"]);
    const tagged = list.items.find((r) => r.id === "b")!;
    expect(tagged.tags).toEqual(["Curry"]);
    expect(tagged.favorite).toBe(false);
    const tags = await (await root.request("/v1/recipes/tags", {}, env)).json() as { items: Array<{ tag: string }> };
    expect(tags.items.map((t) => t.tag)).toEqual(["Curry"]);

    const off = await (await root.request("/v1/recipes/a", send("PATCH", { want_to_cook: false }), env)).json() as Recipe & { want_to_cook: boolean };
    expect(off).toMatchObject({ want_to_cook: false, favorite: true });
    const on = await (await root.request("/v1/recipes/c", send("PATCH", { tags: ["Want to Cook", "Dal"] }), env)).json() as Recipe & { want_to_cook: boolean };
    expect(on).toMatchObject({ want_to_cook: true, tags: ["Dal"] });
  });

  it("drops a step's links to ingredients the recipe no longer has", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    const created = await (await root.request("/v1/recipes", send("POST", {
      title: "Afghani chicken", ingredients: ["Marinade:", "1 kg chicken", "1 cup curd", "Gravy:", "1 cup milk"],
      steps: [{ text: "Marinate.", uses: [0, 1, 7] }, { text: "Add the milk.", uses: [2] }],
    }), env)).json() as Recipe;
    expect(created.steps.map((s) => s.uses)).toEqual([[0, 1], [2]]);
    const shorter = await (await root.request(`/v1/recipes/${created.id}`, send("PATCH", { ingredients: ["1 kg chicken", "1 cup curd"] }), env)).json() as typeof created;
    expect(shorter.steps.map((s) => s.uses)).toEqual([[0, 1], []]);
  });

  it("renames and removes a tag across recipes", async () => {
    const env = { DB: d1() } as Env;
    const root = app();
    await root.request("/v1/recipes", send("POST", { title: "Dal", tags: ["dinner", "Quick"] }), env);
    await root.request("/v1/recipes", send("POST", { title: "Rice", tags: ["Weeknight", "Dinner"] }), env);
    await root.request("/v1/recipes", send("POST", { title: "Cake", tags: ["Baking"] }), env);
    const renamed = await (await root.request("/v1/recipes/tags/rename", send("POST", { from: "DINNER", to: "Weeknight" }), env)).json();
    expect(renamed).toEqual({ changed: 2 });
    const all = await (await root.request("/v1/recipes", {}, env)).json() as { items: Recipe[] };
    expect(Object.fromEntries(all.items.map((r) => [r.title, r.tags]))).toEqual({ Dal: ["Weeknight", "Quick"], Rice: ["Weeknight"], Cake: ["Baking"] });
    expect((await root.request("/v1/recipes/tags/rename", send("POST", { from: "Quick", to: "want to cook" }), env)).status).toBe(400);
    expect(await (await root.request("/v1/recipes/tags/Weeknight", send("DELETE"), env)).json()).toEqual({ changed: 2 });
    const after = await (await root.request("/v1/recipes", {}, env)).json() as { items: Recipe[] };
    expect(after.items).toHaveLength(3);
    expect(after.items.flatMap((r) => r.tags).sort()).toEqual(["Baking", "Quick"]);
  });
});
