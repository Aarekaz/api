import { decodeEntities } from "./links";

// Reading recipes: the amount at the start of an ingredient line, ISO 8601
// durations, and a whole recipe from a web page (schema.org Recipe JSON-LD,
// then microdata and common class names as a fallback).

export type Ingredient = {
  text: string;
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  item: string;
  group: string | null;
};

export type Step = { text: string; group: string | null };

export type RecipeDraft = {
  title: string;
  summary: string | null;
  source_url: string | null;
  source_name: string | null;
  author: string | null;
  image_url: string | null;
  servings: number | null;
  yield_text: string | null;
  prep_minutes: number | null;
  cook_minutes: number | null;
  total_minutes: number | null;
  ingredients: Ingredient[];
  steps: Step[];
  tags: string[];
};

/** How much of the recipe a page gave us: the full schema, a partial read of the page, or only its title. */
export type ImportFound = "schema" | "page" | "basic";

const FRACTIONS: Record<string, string> = {
  "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
  "⅙": "1/6", "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};

// Longest first, so "tablespoons" wins over "t" and "fl oz" over "oz".
const UNITS = [
  "tablespoons", "tablespoon", "teaspoons", "teaspoon", "kilograms", "kilogram", "milliliters", "millilitres", "milliliter", "millilitre",
  "handfuls", "handful", "bunches", "bunch", "pinches", "pinch", "dashes", "dash", "cloves", "clove", "ounces", "ounce", "pounds", "pound",
  "liters", "litres", "liter", "litre", "quarts", "quart", "pints", "pint", "grams", "gram", "sprigs", "sprig", "slices", "slice",
  "sticks", "stick", "pieces", "piece", "cans", "can", "cups", "cup", "fl oz", "tbsp", "tbs", "tsp", "lbs", "lb", "oz", "kg", "ml", "qt",
  "pt", "cl", "dl", "g", "l", "c", "T", "t",
];

const clean = (s: string) => decodeEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ")
  // Recipe plugins often wrap a note in their own brackets: "((fine chopped))".
  .replace(/\(\(([^()]*)\)\)/g, "($1)").replace(/\s+([,.;:!?)])/g, "$1").replace(/\(\s+/g, "(").trim();

function toNumber(token: string): number | null {
  const t = token.trim().replace(",", ".");
  const mixed = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[2]) && Number(mixed[3]) ? Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]) : null;
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[2]) ? Number(frac[1]) / Number(frac[2]) : null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const AMOUNT = String.raw`(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)`;
const LEAD = new RegExp(String.raw`^${AMOUNT}(?:\s*(?:-|–|—|to)\s*${AMOUNT})?\s*`, "i");

/** "1 ½ cups (190 g) flour, sifted" → 1.5, "cups", "(190 g) flour, sifted". The line itself is kept as written. */
export function parseIngredient(line: string, group: string | null = null): Ingredient {
  const text = clean(line).slice(0, 500);
  // "1½" → "1 1/2", "½" → "1/2"
  const spelled = text.replace(/(\d)?([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (_, whole: string | undefined, f: string) => `${whole ? whole + " " : ""}${FRACTIONS[f]}`)
    .replace(/(\d)\s*⁄\s*(\d)/g, "$1/$2");
  const lead = spelled.match(LEAD);
  let quantity: number | null = null, max: number | null = null, rest = spelled;
  if (lead) {
    quantity = toNumber(lead[1]);
    max = lead[2] ? toNumber(lead[2]) : null;
    rest = spelled.slice(lead[0].length);
  }
  let unit: string | null = null;
  if (quantity !== null) {
    for (const u of UNITS) {
      const caseSensitive = u === "T" || u === "t";
      const head = rest.slice(0, u.length);
      const same = caseSensitive ? head === u : head.toLowerCase() === u.toLowerCase();
      if (same && /^(\.|\s|$|,)/.test(rest.slice(u.length))) {
        unit = u;
        rest = rest.slice(u.length).replace(/^\./, "");
        break;
      }
    }
  }
  const item = rest.replace(/^\s*(of\s+)?/i, "").trim();
  return {
    text, quantity: quantity === null ? null : round(quantity), quantity_max: max !== null && quantity !== null && max > quantity ? round(max) : null,
    unit, item: item || text, group,
  };
}

/** A line ending in ":" with no amount ("For the sauce:") starts a group. */
const isHeading = (line: string) => /:\s*$/.test(line) && !/^\s*[\d½⅓⅔¼¾⅛]/.test(line) && line.length <= 80;

/** Ingredient lines (strings, or objects already parsed) with headings folded into groups. */
export function cleanIngredients(input: unknown): Ingredient[] {
  if (!Array.isArray(input)) return [];
  const out: Ingredient[] = [];
  let group: string | null = null;
  for (const raw of input.slice(0, 200)) {
    if (typeof raw === "string") {
      const line = clean(raw);
      if (!line) continue;
      if (isHeading(line)) { group = line.replace(/:\s*$/, "").slice(0, 80); continue; }
      out.push(parseIngredient(line, group));
    } else if (raw && typeof raw === "object" && typeof (raw as { text?: unknown }).text === "string") {
      const r = raw as { text: string; group?: unknown };
      const line = clean(r.text);
      if (!line) continue;
      out.push(parseIngredient(line, typeof r.group === "string" && r.group.trim() ? r.group.trim().slice(0, 80) : group));
    }
  }
  return out;
}

/** Step lines (strings or {text, group}) with headings folded into groups. */
export function cleanSteps(input: unknown): Step[] {
  if (!Array.isArray(input)) return [];
  const out: Step[] = [];
  let group: string | null = null;
  for (const raw of input.slice(0, 120)) {
    const text = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof (raw as { text?: unknown }).text === "string" ? (raw as { text: string }).text : null;
    if (text === null) continue;
    const line = clean(text).replace(/^(step\s*)?\d+[.)]\s+/i, "").slice(0, 4000);
    if (!line) continue;
    if (typeof raw === "string" && isHeading(line) && line.split(" ").length <= 6) { group = line.replace(/:\s*$/, ""); continue; }
    const own = typeof raw === "object" && raw && typeof (raw as { group?: unknown }).group === "string" ? String((raw as { group: string }).group).trim().slice(0, 80) : null;
    out.push({ text: line, group: own || group });
  }
  return out;
}

/** "PT1H30M" → 90, "P0DT0H20M" → 20, "45" → 45, "1 hour 10 mins" → 70. */
export function parseDuration(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 0 ? Math.round(value) : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  const iso = v.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (iso) {
    const minutes = Number(iso[1] ?? 0) * 1440 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0) + Number(iso[4] ?? 0) / 60;
    return minutes > 0 ? Math.round(minutes) : null;
  }
  if (/^\d+$/.test(v)) return Number(v) > 0 ? Number(v) : null;
  const hours = v.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i);
  const mins = v.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0);
  return total > 0 ? Math.round(total) : null;
}

/** recipeYield: "4", 4, "4 servings", "Serves 4-6", ["4", "4 servings"], "12 cookies". */
export function parseYield(value: unknown): { servings: number | null; yield_text: string | null } {
  const list = Array.isArray(value) ? value : [value];
  let servings: number | null = null, text: string | null = null;
  for (const v of list) {
    const s = typeof v === "number" ? String(v) : typeof v === "string" ? clean(v) : "";
    if (!s) continue;
    const n = s.match(/(\d+(?:\.\d+)?)/);
    if (servings === null && n) servings = Number(n[1]);
    // Keep words that say what it makes ("12 cookies", "1 loaf"), not "4 servings".
    const words = s.replace(/\d+(?:\.\d+)?(\s*(-|–|to)\s*\d+)?/g, "").replace(/\b(serves|servings?|people|persons?|portions?|makes|yield|yields)\b/gi, "").replace(/[:()]/g, "").trim();
    if (!text && words) text = s.slice(0, 80);
  }
  return { servings: servings && servings > 0 && servings < 1000 ? servings : null, yield_text: text };
}

type Node = Record<string, unknown>;

const typeOf = (node: Node): string[] => {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string").map((x) => x.replace(/^.*[/:]/, ""));
};

/** Every Recipe node in a JSON-LD value, including inside @graph, arrays and mainEntity. */
function findRecipes(value: unknown, depth = 0, out: Node[] = []): Node[] {
  if (depth > 8 || !value || typeof value !== "object") return out;
  if (Array.isArray(value)) { for (const v of value) findRecipes(v, depth + 1, out); return out; }
  const node = value as Node;
  if (typeOf(node).includes("Recipe")) out.push(node);
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    if (node[key] && typeof node[key] === "object") findRecipes(node[key], depth + 1, out);
  }
  return out;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return clean(value) || null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (value && typeof value === "object") return text((value as Node).name ?? (value as Node)["@value"]);
  return null;
}

function absolute(src: string | null, base: string): string | null {
  if (!src || src.startsWith("data:")) return null;
  try {
    const url = new URL(decodeEntities(src.trim()), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

function image(value: unknown, base: string): string | null {
  if (typeof value === "string") return absolute(value, base);
  if (Array.isArray(value)) {
    // Pick the widest when sizes are given; otherwise the first.
    const objects = value.filter((v) => v && typeof v === "object") as Node[];
    const sized = objects.filter((o) => Number(o.width) > 0).sort((a, b) => Number(b.width) - Number(a.width));
    return image(sized[0] ?? value[0], base);
  }
  if (value && typeof value === "object") {
    const o = value as Node;
    return image(o.url ?? o.contentUrl ?? o["@id"], base);
  }
  return null;
}

/** recipeInstructions as steps: a string, a list of strings, HowToStep, HowToSection, ItemList. */
function instructions(value: unknown, group: string | null = null, out: Step[] = [], depth = 0): Step[] {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === "string") {
    const pieces = /<(li|p)\b/i.test(value)
      ? [...value.matchAll(/<(li|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2])
      : value.split(/\r?\n+|(?<=\.)\s{2,}/);
    for (const piece of pieces) {
      const line = clean(piece).replace(/^(step\s*)?\d+[.)]\s+/i, "");
      if (line) out.push({ text: line.slice(0, 4000), group });
    }
    return out;
  }
  if (Array.isArray(value)) { for (const v of value) instructions(v, group, out, depth + 1); return out; }
  if (typeof value === "object") {
    const node = value as Node;
    const types = typeOf(node);
    if (types.includes("HowToSection") || (types.includes("ItemList") && node.itemListElement)) {
      const name = text(node.name);
      return instructions(node.itemListElement, name ?? group, out, depth + 1);
    }
    const body = typeof node.text === "string" ? node.text : typeof node.name === "string" ? node.name : null;
    if (body) instructions(body, group, out, depth + 1);
    else if (node.itemListElement) instructions(node.itemListElement, group, out, depth + 1);
  }
  return out;
}

function keywords(...values: unknown[]): string[] {
  const tags: string[] = [];
  for (const v of values) {
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
    for (const t of list) {
      const tag = typeof t === "string" ? clean(t) : "";
      if (tag && tag.length <= 32 && !tags.some((x) => x.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    }
  }
  return tags.slice(0, 6);
}

function metaTags(html: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? "";
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").toLowerCase();
    if (key && attrs.content && !meta.has(key)) meta.set(key, decodeEntities(attrs.content).trim());
  }
  return meta;
}

function siteName(url: string, meta: Map<string, string>): string | null {
  const og = meta.get("og:site_name");
  if (og) return og.slice(0, 80);
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/^\s*\/\/.*$/gm, "");
    try { blocks.push(JSON.parse(raw)); continue; } catch { /* try again without raw control characters */ }
    try { blocks.push(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " "))); } catch { /* not JSON */ }
  }
  return blocks;
}

function fromSchema(node: Node, url: string, meta: Map<string, string>): RecipeDraft {
  const y = parseYield(node.recipeYield ?? node.yield);
  const author = Array.isArray(node.author) ? node.author.map(text).filter(Boolean).join(", ") : text(node.author);
  const prep = parseDuration(node.prepTime), cook = parseDuration(node.cookTime);
  return {
    title: (text(node.name) ?? meta.get("og:title") ?? "Untitled recipe").slice(0, 200),
    summary: (text(node.description) ?? meta.get("og:description") ?? null)?.slice(0, 1000) ?? null,
    source_url: url,
    source_name: text((node.publisher as Node | undefined)?.name) ?? siteName(url, meta),
    author: author ? author.slice(0, 120) : null,
    image_url: image(node.image, url) ?? absolute(meta.get("og:image") ?? null, url),
    servings: y.servings, yield_text: y.yield_text,
    prep_minutes: prep, cook_minutes: cook,
    total_minutes: parseDuration(node.totalTime) ?? (prep || cook ? (prep ?? 0) + (cook ?? 0) : null),
    ingredients: cleanIngredients(node.recipeIngredient ?? node.ingredients),
    steps: instructions(node.recipeInstructions).slice(0, 120),
    tags: keywords(node.recipeCategory, node.recipeCuisine),
  };
}

/** Lists by microdata (itemprop) or by the class names recipe plugins use. */
function fromPage(html: string, url: string, meta: Map<string, string>): RecipeDraft {
  const pick = (re: RegExp) => [...html.matchAll(re)].map((m) => m[m.length - 1]);
  let ingredients = pick(/<(\w+)\b[^>]*itemprop\s*=\s*["'](?:recipeIngredient|ingredients)["'][^>]*>([\s\S]*?)<\/\1>/gi);
  if (ingredients.length === 0) ingredients = pick(/<li\b[^>]*class\s*=\s*["'][^"']*ingredient[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi);
  let steps: Step[] = [];
  const blocks = pick(/<(\w+)\b[^>]*itemprop\s*=\s*["']recipeInstructions["'][^>]*>([\s\S]*?)<\/\1>/gi);
  if (blocks.length) steps = instructions(blocks.length === 1 ? blocks[0] : blocks);
  if (steps.length === 0) steps = instructions(pick(/<li\b[^>]*class\s*=\s*["'][^"']*(?:instruction|direction|step)[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi));
  const title = meta.get("og:title") ?? (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ? clean(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)![1]) : null)
    ?? (html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ? clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)![1]) : null);
  const y = parseYield(meta.get("recipeyield") ?? null);
  return {
    title: (title || "Untitled recipe").slice(0, 200),
    summary: (meta.get("og:description") ?? meta.get("description") ?? null)?.slice(0, 1000) ?? null,
    source_url: url, source_name: siteName(url, meta), author: meta.get("author")?.slice(0, 120) ?? null,
    image_url: absolute(meta.get("og:image") ?? meta.get("twitter:image") ?? null, url),
    servings: y.servings, yield_text: y.yield_text,
    prep_minutes: parseDuration(meta.get("preptime")), cook_minutes: parseDuration(meta.get("cooktime")), total_minutes: parseDuration(meta.get("totaltime")),
    ingredients: cleanIngredients(ingredients), steps: steps.slice(0, 120), tags: [],
  };
}

/** The recipe on a page: schema.org JSON-LD first (the fullest), then whatever the page's markup gives. */
export function extractRecipe(html: string, url: string): { recipe: RecipeDraft; found: ImportFound } {
  const meta = metaTags(html);
  const nodes = jsonLdBlocks(html).flatMap((b) => findRecipes(b));
  // A page can carry several (a roundup); the one with the most ingredients is the recipe.
  const best = nodes.map((n) => fromSchema(n, url, meta)).sort((a, b) => b.ingredients.length + b.steps.length - (a.ingredients.length + a.steps.length))[0];
  if (best && (best.ingredients.length || best.steps.length)) {
    if (best.steps.length === 0) best.steps = fromPage(html, url, meta).steps;
    return { recipe: best, found: "schema" };
  }
  const page = fromPage(html, url, meta);
  if (best) { best.ingredients = page.ingredients; best.steps = page.steps; }
  const recipe = best ?? page;
  return { recipe, found: recipe.ingredients.length || recipe.steps.length ? "page" : "basic" };
}
