#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_API_BASE_URL = "https://api.anuragd.me";
const DEFAULT_OUT_FILE = "tmp/tmdb-shelf-poster-preview.json";
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
const POSTER_SIZE = "w500";
const REQUEST_DELAY_MS = 120;

const args = parseArgs(process.argv.slice(2));
await loadEnvFiles([...args.envFiles, ".env.local", ".dev.vars", ".env"]);

if (args.help) {
  printUsage();
  process.exit(0);
}

const apiBaseUrl = normalizeApiBaseUrl(
  args.apiUrl ?? process.env.API_BASE_URL ?? process.env.API_URL ?? DEFAULT_API_BASE_URL,
);
const apiToken = args.token ?? process.env.API_TOKEN;
const tmdbApiKey = args.tmdbApiKey ?? process.env.TMDB_API_KEY;
const tmdbAccessToken = args.tmdbAccessToken ?? process.env.TMDB_ACCESS_TOKEN;
const outFile = resolve(args.out ?? DEFAULT_OUT_FILE);

if (!apiToken) {
  throw new Error("Missing API_TOKEN. Set it in an env file or pass --token.");
}
if (!tmdbApiKey && !tmdbAccessToken) {
  throw new Error("Missing TMDB_API_KEY or TMDB_ACCESS_TOKEN. Add one to an env file or pass --tmdb-api-key.");
}

const shelfItems = await fetchExistingShelfItems(apiBaseUrl, apiToken);
const mediaItems = shelfItems
  .filter((item) => isMovie(item) || isShow(item))
  .filter((item) => args.includeExisting || !item.image_url)
  .slice(0, args.limit ?? shelfItems.length);

const matches = [];
for (const item of mediaItems) {
  const match = await findTmdbPoster(item, { tmdbApiKey, tmdbAccessToken });
  matches.push(match);
  await delay(REQUEST_DELAY_MS);
}

const matched = matches.filter((match) => match.poster_url);
const preview = {
  source: "tmdb",
  generated_at: new Date().toISOString(),
  mode: args.commit ? "commit" : "dry-run",
  api_url: apiBaseUrl,
  stats: {
    shelf_items: shelfItems.length,
    media_items_checked: mediaItems.length,
    matched: matched.length,
    unmatched: matches.length - matched.length,
  },
  matches,
};

if (args.commit) {
  preview.patch_result = await patchMatchedItems({
    apiBaseUrl,
    apiToken,
    matches: matched,
  });
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(preview, null, 2)}\n`);

console.log(`${args.commit ? "Poster enrichment complete" : "Poster dry run complete"}`);
console.log(`  Checked: ${preview.stats.media_items_checked}`);
console.log(`  Matched: ${preview.stats.matched}`);
console.log(`  Unmatched: ${preview.stats.unmatched}`);
if (preview.patch_result) {
  console.log(`  Patched: ${preview.patch_result.patched.length}`);
  console.log(`  Failed: ${preview.patch_result.failed.length}`);
}
console.log(`Preview written to ${outFile}`);

function parseArgs(argv) {
  const parsed = {
    commit: false,
    help: false,
    includeExisting: false,
    envFiles: [],
    limit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--commit") parsed.commit = true;
    else if (arg === "--include-existing") parsed.includeExisting = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--env-file") {
      parsed.envFiles.push(requireValue(arg, next));
      index += 1;
    } else if (arg.startsWith("--env-file=")) {
      parsed.envFiles.push(arg.slice("--env-file=".length));
    } else if (arg === "--out") {
      parsed.out = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--out=")) {
      parsed.out = arg.slice("--out=".length);
    } else if (arg === "--api-url") {
      parsed.apiUrl = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--api-url=")) {
      parsed.apiUrl = arg.slice("--api-url=".length);
    } else if (arg === "--token") {
      parsed.token = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--token=")) {
      parsed.token = arg.slice("--token=".length);
    } else if (arg === "--tmdb-api-key") {
      parsed.tmdbApiKey = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--tmdb-api-key=")) {
      parsed.tmdbApiKey = arg.slice("--tmdb-api-key=".length);
    } else if (arg === "--tmdb-access-token") {
      parsed.tmdbAccessToken = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--tmdb-access-token=")) {
      parsed.tmdbAccessToken = arg.slice("--tmdb-access-token=".length);
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInteger(requireValue(arg, next));
      index += 1;
    } else if (arg.startsWith("--limit=")) {
      parsed.limit = parsePositiveInteger(arg.slice("--limit=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`
Usage:
  npm run enrich:shelf-posters:tmdb -- [options]

Options:
  --env-file <path>          Optional env file to read before .env.local/.env
  --out <path>               Preview JSON path (default: ${DEFAULT_OUT_FILE})
  --commit                   PATCH matched shelf items with poster URLs
  --include-existing         Re-check items that already have image_url
  --api-url <url>            API base URL (default: ${DEFAULT_API_BASE_URL})
  --token <token>            API bearer token (or set API_TOKEN)
  --tmdb-api-key <key>       TMDB v3 API key (or set TMDB_API_KEY)
  --tmdb-access-token <jwt>  TMDB v4 read token (or set TMDB_ACCESS_TOKEN)
  --limit <number>           Limit items checked, useful for testing
`);
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInteger(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return number;
}

async function loadEnvFiles(paths) {
  for (const filePath of paths) {
    try {
      await loadEnvFile(filePath);
    } catch {
      // Optional env files are expected to be absent in some environments.
    }
  }
}

async function loadEnvFile(filePath) {
  const text = await readFile(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

async function fetchExistingShelfItems(apiBaseUrl, apiToken) {
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${apiBaseUrl}/v1/shelf`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("include_unpublished", "true");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to fetch shelf: ${response.status} ${response.statusText}: ${bodyText.slice(0, 300)}`);
    }

    const page = JSON.parse(bodyText);
    if (!Array.isArray(page)) throw new Error("Expected /v1/shelf to return an array.");
    items.push(...page);
    if (page.length < 1000) break;
  }
  return items;
}

async function findTmdbPoster(item, auth) {
  const mediaType = isShow(item) ? "tv" : "movie";
  const title = cleanTitle(item.title);
  const year = getTag(item, "year");
  const url = new URL(`${TMDB_API_BASE_URL}/search/${mediaType}`);
  url.searchParams.set("query", title);
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("language", "en-US");
  url.searchParams.set("page", "1");
  if (year) {
    url.searchParams.set(mediaType === "tv" ? "first_air_date_year" : "year", year);
  }
  if (auth.tmdbApiKey) {
    url.searchParams.set("api_key", auth.tmdbApiKey);
  }

  const headers = auth.tmdbAccessToken
    ? { Authorization: `Bearer ${auth.tmdbAccessToken}` }
    : {};
  const response = await fetch(url, { headers });
  const bodyText = await response.text();
  if (!response.ok) {
    return baseMatch(item, {
      status: "error",
      error: `${response.status} ${response.statusText}: ${bodyText.slice(0, 200)}`,
    });
  }

  const body = JSON.parse(bodyText);
  const results = Array.isArray(body.results) ? body.results : [];
  const result = chooseBestResult(results, title, year, mediaType);
  if (!result?.poster_path) {
    return baseMatch(item, {
      status: "unmatched",
      candidates: results.slice(0, 3).map((candidate) => candidateSummary(candidate, mediaType)),
    });
  }

  return baseMatch(item, {
    status: "matched",
    tmdb_id: result.id,
    tmdb_title: result.title ?? result.name,
    tmdb_year: dateYear(result.release_date ?? result.first_air_date),
    poster_path: result.poster_path,
    poster_url: `${TMDB_IMAGE_BASE_URL}/${POSTER_SIZE}${result.poster_path}`,
    score: result._score,
  });
}

function chooseBestResult(results, title, year, mediaType) {
  const titleKey = normalizeTitle(title);
  const scored = results
    .filter((result) => result.poster_path)
    .map((result) => {
      const candidateTitle = result.title ?? result.name ?? result.original_title ?? result.original_name ?? "";
      const candidateYear = dateYear(result.release_date ?? result.first_air_date);
      let score = 0;
      if (normalizeTitle(candidateTitle) === titleKey) score += 50;
      if (candidateYear && year && String(candidateYear) === String(year)) score += 25;
      score += Math.min(Number(result.popularity) || 0, 50) / 5;
      score += Math.min(Number(result.vote_count) || 0, 1000) / 200;
      return { ...result, _score: Number(score.toFixed(2)), _media_type: mediaType };
    })
    .sort((left, right) => right._score - left._score);
  return scored[0] ?? null;
}

async function patchMatchedItems({ apiBaseUrl, apiToken, matches }) {
  const result = { patched: [], failed: [] };
  for (const match of matches) {
    const tags = mergeTags(match.tags, [
      `tmdb_id:${match.tmdb_id}`,
      `tmdb_media_type:${match.media_type}`,
      `poster_source:tmdb`,
    ]);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/shelf/${match.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: match.poster_url,
          tags,
        }),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${bodyText.slice(0, 300)}`);
      }
      result.patched.push({ id: match.id, type: match.type, title: match.title });
      await delay(REQUEST_DELAY_MS);
    } catch (error) {
      result.failed.push({
        id: match.id,
        type: match.type,
        title: match.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

function baseMatch(item, fields) {
  const mediaType = isShow(item) ? "tv" : "movie";
  return {
    id: item.id,
    type: item.type,
    media_type: mediaType,
    title: item.title,
    year: getTag(item, "year") ?? null,
    tags: Array.isArray(item.tags) ? item.tags : [],
    ...fields,
  };
}

function candidateSummary(candidate, mediaType) {
  return {
    id: candidate.id,
    title: candidate.title ?? candidate.name,
    year: dateYear(candidate.release_date ?? candidate.first_air_date),
    has_poster: Boolean(candidate.poster_path),
    popularity: candidate.popularity ?? null,
    media_type: mediaType,
  };
}

function mergeTags(currentTags, newTags) {
  const byKey = new Map();
  for (const tag of [...currentTags, ...newTags]) {
    const [key] = String(tag).split(":");
    byKey.set(key, tag);
  }
  return [...byKey.values()];
}

function isShow(item) {
  return item.type === "show" || item.drawer === "shows" || getTag(item, "kind") === "show";
}

function isMovie(item) {
  return item.type === "movie" || item.drawer === "movies" || getTag(item, "kind") === "movie";
}

function getTag(item, key) {
  const tags = item.tags;
  if (!Array.isArray(tags)) return undefined;
  const prefix = `${key.toLowerCase()}:`;
  const match = tags.find((tag) => String(tag).toLowerCase().startsWith(prefix));
  return match ? String(match).slice(prefix.length) : undefined;
}

function cleanTitle(title) {
  return String(title ?? "")
    .replace(/\s+\(\d{4}\)$/u, "")
    .replace(/\s+\(\d{4}[-\u2013]\d{4}\)$/u, "")
    .trim();
}

function normalizeTitle(title) {
  return cleanTitle(title)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dateYear(value) {
  const match = /^(\d{4})/.exec(String(value ?? ""));
  return match ? match[1] : null;
}

function normalizeApiBaseUrl(value) {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
