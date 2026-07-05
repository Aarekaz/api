#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_API_BASE_URL = "https://api.anuragd.me";
const DEFAULT_OUT_FILE = "tmp/tmdb-shelf-metadata-backfill.json";
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
const POSTER_SIZE = "w500";
const BACKDROP_SIZE = "w1280";
const REQUEST_DELAY_MS = 100;

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
  .filter((item) => args.includeExisting || !hasTmdbMetadata(item))
  .filter((item) => Boolean(getTag(item, "tmdb_id")))
  .slice(0, args.limit ?? shelfItems.length);

const matches = [];
for (const item of mediaItems) {
  matches.push(await fetchTmdbMetadata(item, { tmdbApiKey, tmdbAccessToken }));
  await delay(REQUEST_DELAY_MS);
}

const matched = matches.filter((match) => match.status === "matched");
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

console.log(`${args.commit ? "TMDB metadata backfill complete" : "TMDB metadata dry run complete"}`);
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
  npm run backfill:shelf-tmdb-metadata -- [options]

Options:
  --commit                   PATCH matched shelf items with metadata.tmdb
  --include-existing         Re-check items that already have metadata.tmdb
  --env-file <path>          Optional env file to read before .env.local/.env
  --out <path>               Preview JSON path (default: ${DEFAULT_OUT_FILE})
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

async function fetchTmdbMetadata(item, auth) {
  const tmdbId = getTag(item, "tmdb_id");
  const mediaType = normalizeMediaType(getTag(item, "tmdb_media_type") ?? (isShow(item) ? "tv" : "movie"));
  if (!tmdbId || !mediaType) {
    return baseMatch(item, { status: "unmatched", error: "Missing TMDB id or media type" });
  }

  const url = new URL(`${TMDB_API_BASE_URL}/${mediaType}/${tmdbId}`);
  url.searchParams.set("language", "en-US");
  if (auth.tmdbApiKey) url.searchParams.set("api_key", auth.tmdbApiKey);

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

  const detail = JSON.parse(bodyText);
  const title = detail.title ?? detail.name ?? item.title;
  const originalTitle = detail.original_title ?? detail.original_name;
  const releaseDate = detail.release_date ?? detail.first_air_date;
  const year = dateYear(releaseDate);
  const posterPath = detail.poster_path ?? null;
  const backdropPath = detail.backdrop_path ?? null;

  return baseMatch(item, {
    status: "matched",
    tags: mergeTags(item.tags ?? [], [
      `tmdb_id:${tmdbId}`,
      `tmdb_media_type:${mediaType}`,
      "poster_source:tmdb",
      year ? `year:${year}` : "",
    ]),
    metadata: mergeMetadata(item.metadata, {
      id: Number(tmdbId),
      tmdb_id: Number(tmdbId),
      media_type: mediaType,
      tmdb_media_type: mediaType,
      title,
      original_title: originalTitle,
      original_name: detail.original_name,
      release_date: detail.release_date,
      first_air_date: detail.first_air_date,
      year,
      overview: detail.overview,
      poster_path: posterPath,
      poster_url: posterPath ? `${TMDB_IMAGE_BASE_URL}/${POSTER_SIZE}${posterPath}` : undefined,
      backdrop_path: backdropPath,
      backdrop_url: backdropPath ? `${TMDB_IMAGE_BASE_URL}/${BACKDROP_SIZE}${backdropPath}` : undefined,
      vote_average: detail.vote_average,
      vote_count: detail.vote_count,
      popularity: detail.popularity,
    }),
  });
}

async function patchMatchedItems({ apiBaseUrl, apiToken, matches }) {
  const result = { patched: [], failed: [] };
  for (const match of matches) {
    try {
      const response = await fetch(`${apiBaseUrl}/v1/shelf/${match.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: match.metadata,
          tags: match.tags,
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
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    current_image_url: item.image_url ?? null,
    ...fields,
  };
}

function mergeMetadata(currentMetadata, tmdb) {
  const metadata = currentMetadata && typeof currentMetadata === "object" && !Array.isArray(currentMetadata)
    ? { ...currentMetadata }
    : {};
  metadata.tmdb = Object.fromEntries(
    Object.entries(tmdb).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  return metadata;
}

function mergeTags(currentTags, newTags) {
  const byKey = new Map();
  for (const tag of [...currentTags, ...newTags]) {
    const normalized = String(tag).trim();
    if (!normalized) continue;
    const [key] = normalized.split(":");
    byKey.set(key.toLowerCase(), normalized);
  }
  return [...byKey.values()];
}

function hasTmdbMetadata(item) {
  return Boolean(
    item.metadata &&
      typeof item.metadata === "object" &&
      !Array.isArray(item.metadata) &&
      item.metadata.tmdb &&
      typeof item.metadata.tmdb === "object",
  );
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

function normalizeMediaType(value) {
  if (value === "movie") return "movie";
  if (value === "tv" || value === "show") return "tv";
  return null;
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
