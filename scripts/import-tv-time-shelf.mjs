#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_EXPORT_DIR = "/Users/aarekaz/Downloads/tv-time-personal-data";
const DEFAULT_API_BASE_URL = "https://api.anuragd.me";
const DEFAULT_OUT_FILE = "tmp/tv-time-shelf-preview.json";
const COMMIT_DELAY_MS = 150;

const WATCH_HISTORY_FILES = [
  "seen_episode.csv",
  "followed_tv_show.csv",
  "tracking-prod-records.csv",
  "tracking-prod-records-v2.csv",
  "ratings-v2-prod-votes.csv",
  "ratings-3-prod-episode_votes.csv",
];

const args = parseArgs(process.argv.slice(2));
await loadEnvFiles([...args.envFiles, ".env.local", ".dev.vars", ".env"]);

if (args.help) {
  printUsage();
  process.exit(0);
}

const exportDir = resolve(args.exportDir ?? process.env.TV_TIME_EXPORT_DIR ?? DEFAULT_EXPORT_DIR);
const outFile = resolve(args.out ?? DEFAULT_OUT_FILE);
const apiBaseUrl = normalizeApiBaseUrl(
  args.apiUrl ?? process.env.API_BASE_URL ?? process.env.API_URL ?? DEFAULT_API_BASE_URL
);
const apiToken = args.token ?? process.env.API_TOKEN;

const warnings = [];
const files = await readTvTimeFiles(exportDir, warnings);
const items = buildShelfItems(files, {
  includeQueued: args.includeQueued,
  limit: args.limit,
  warnings,
});

const preview = {
  source: "tv-time",
  generated_at: new Date().toISOString(),
  mode: args.commit ? "commit" : "dry-run",
  export_dir: exportDir,
  files_read: WATCH_HISTORY_FILES,
  warnings,
  stats: {
    seen_episode_rows: files.seenEpisodes.length,
    followed_tv_show_rows: files.followedShows.length,
    tracking_rows: files.trackingRecords.length,
    tracking_v2_rows: files.trackingRecordsV2.length,
    show_items: items.filter((item) => item.type === "show").length,
    movie_items: items.filter((item) => item.type === "movie").length,
    total_items: items.length,
  },
  items,
};

if (args.commit) {
  if (!apiToken) {
    throw new Error("Missing API_TOKEN. Set it in the environment or pass --token before using --commit.");
  }
  preview.import_result = await commitItems({
    apiBaseUrl,
    apiToken,
    items,
    dryRun: false,
  });
} else if (args.checkExisting) {
  if (!apiToken) {
    warnings.push("Skipped existing-item check because API_TOKEN is missing.");
  } else {
    preview.existing_check = await checkExistingItems({ apiBaseUrl, apiToken, items });
  }
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(preview, null, 2)}\n`);

console.log(`${args.commit ? "Import complete" : "Dry run complete"}: ${items.length} shelf items`);
console.log(`  Shows: ${preview.stats.show_items}`);
console.log(`  Movies: ${preview.stats.movie_items}`);
if (preview.import_result) {
  console.log(`  Created: ${preview.import_result.created.length}`);
  console.log(`  Skipped existing: ${preview.import_result.skipped_existing.length}`);
  console.log(`  Failed: ${preview.import_result.failed.length}`);
}
if (warnings.length) {
  console.log(`  Warnings: ${warnings.length}`);
}
console.log(`Preview written to ${outFile}`);

function parseArgs(argv) {
  const parsed = {
    commit: false,
    checkExisting: false,
    includeQueued: false,
    help: false,
    envFiles: [],
    limit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--commit") parsed.commit = true;
    else if (arg === "--check-existing") parsed.checkExisting = true;
    else if (arg === "--include-queued") parsed.includeQueued = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--export-dir") {
      parsed.exportDir = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--export-dir=")) {
      parsed.exportDir = arg.slice("--export-dir=".length);
    } else if (arg === "--out") {
      parsed.out = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--out=")) {
      parsed.out = arg.slice("--out=".length);
    } else if (arg === "--env-file") {
      parsed.envFiles.push(requireValue(arg, next));
      index += 1;
    } else if (arg.startsWith("--env-file=")) {
      parsed.envFiles.push(arg.slice("--env-file=".length));
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

function printUsage() {
  console.log(`
Usage:
  npm run import:tv-time:shelf -- [options]

Options:
  --export-dir <path>    TV Time GDPR export directory
  --out <path>           Preview JSON path (default: ${DEFAULT_OUT_FILE})
  --env-file <path>      Optional env file to read before .env.local/.env
  --check-existing       Dry-run GET /v1/shelf and report existing matches
  --include-queued       Include TV Time "to watch" movies as queued shelf items
  --commit               POST new items to /v1/shelf
  --api-url <url>        API base URL (default: ${DEFAULT_API_BASE_URL})
  --token <token>        API bearer token (or set API_TOKEN)
  --limit <number>       Limit generated items, useful for testing
`);
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

async function readTvTimeFiles(exportDir, warnings) {
  await assertDirectory(exportDir);

  return {
    seenEpisodes: await readCsv(join(exportDir, "seen_episode.csv"), warnings, true),
    followedShows: await readCsv(join(exportDir, "followed_tv_show.csv"), warnings, true),
    trackingRecords: await readCsv(join(exportDir, "tracking-prod-records.csv"), warnings, true),
    trackingRecordsV2: await readCsv(join(exportDir, "tracking-prod-records-v2.csv"), warnings, false),
    ratingVotes: [
      ...(await readCsv(join(exportDir, "ratings-v2-prod-votes.csv"), warnings, false)),
      ...(await readCsv(join(exportDir, "ratings-3-prod-episode_votes.csv"), warnings, false)),
    ],
  };
}

async function assertDirectory(path) {
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`Expected a directory: ${path}`);
  }
}

async function readCsv(path, warnings, required) {
  try {
    const text = await readFile(path, "utf8");
    return parseCsv(text);
  } catch (error) {
    if (required) {
      throw error;
    }
    warnings.push(`Optional file unavailable: ${path}`);
    return [];
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const [headerRow, ...dataRows] = rows.filter((entry) =>
    entry.some((value) => value.trim() !== "")
  );
  if (!headerRow) return [];

  const headers = headerRow.map((value) => value.replace(/^\uFEFF/, "").trim());
  return dataRows.map((dataRow) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = (dataRow[index] ?? "").trim();
    });
    return record;
  });
}

function buildShelfItems(files, options) {
  const shows = buildShowItems(files);
  const movies = buildMovieItems(files, options.includeQueued);
  const items = [...shows, ...movies].sort(compareShelfItems);
  return options.limit ? items.slice(0, options.limit) : items;
}

function buildShowItems(files) {
  const followedByTitle = new Map();
  for (const row of files.followedShows) {
    const title = clean(row.tv_show_name);
    if (!title) continue;
    followedByTitle.set(normalizeTitleKey(title), row);
  }

  const v2ByTitle = new Map();
  for (const row of files.trackingRecordsV2) {
    const title = clean(row.series_name);
    if (!title) continue;
    const key = normalizeTitleKey(title);
    const summary = v2ByTitle.get(key) ?? {};
    mergeFirst(summary, "uuid", clean(row.uuid));
    mergeFirst(summary, "series_id", clean(row.s_id));
    mergeFirst(summary, "ep_watch_count", clean(row.ep_watch_count));
    mergeFirst(summary, "series_follow_count", clean(row.series_follow_count));
    mergeFirst(summary, "is_archived", clean(row.is_archived));
    mergeFirst(summary, "is_followed", clean(row.is_followed));
    mergeFirst(summary, "is_for_later", clean(row.is_for_later));
    v2ByTitle.set(key, summary);
  }

  const ratingsByTitle = new Map();
  for (const row of files.ratingVotes) {
    const title = clean(row.series_name);
    if (!title) continue;
    const key = normalizeTitleKey(title);
    ratingsByTitle.set(key, (ratingsByTitle.get(key) ?? 0) + 1);
  }

  const groups = new Map();
  for (const row of files.seenEpisodes) {
    const title = clean(row.tv_show_name);
    if (!title) continue;

    const key = normalizeTitleKey(title);
    const group = groups.get(key) ?? {
      title,
      episodeKeys: new Set(),
      seasons: new Set(),
      firstSeenAt: null,
      lastSeenAt: null,
    };

    const season = parseInteger(row.episode_season_number);
    const episode = parseInteger(row.episode_number);
    if (season !== null) group.seasons.add(season);
    const episodeKey = clean(row.episode_id) || `${season ?? "x"}:${episode ?? "x"}:${clean(row.created_at)}`;
    group.episodeKeys.add(episodeKey);
    group.firstSeenAt = minDate(group.firstSeenAt, safeIsoDate(row.created_at));
    group.lastSeenAt = maxDate(group.lastSeenAt, safeIsoDate(row.created_at));
    groups.set(key, group);
  }

  const items = [];
  for (const [key, group] of groups) {
    const followed = followedByTitle.get(key);
    const v2 = v2ByTitle.get(key) ?? {};
    const episodeCount = group.episodeKeys.size;
    if (episodeCount === 0) continue;

    const seasonCount = group.seasons.size;
    const followedAt = safeIsoDate(followed?.created_at);
    const isArchived = booleanish(followed?.archived ?? v2.is_archived);
    const isFollowed = booleanish(v2.is_followed) ?? Boolean(followed);
    const ratingCount = ratingsByTitle.get(key) ?? 0;
    const tags = compact([
      "source:tv-time",
      "kind:show",
      "status:watched",
      "watched:true",
      `episodes:${episodeCount}`,
      seasonCount ? `seasons:${seasonCount}` : null,
      group.firstSeenAt ? `started_at:${dateOnly(group.firstSeenAt)}` : null,
      group.lastSeenAt ? `watched_at:${dateOnly(group.lastSeenAt)}` : null,
      isFollowed ? "followed:true" : "followed:false",
      isArchived ? "archived:true" : "archived:false",
      ratingCount ? `rated_episodes:${ratingCount}` : null,
      followed?.tv_show_id ? `tv_time_show_id:${followed.tv_show_id}` : null,
      v2.series_id ? `tv_time_series_id:${v2.series_id}` : null,
    ]);

    items.push({
      type: "show",
      title: group.title,
      source: "TV Time",
      drawer: "shows",
      note: buildShowNote({ episodeCount, seasonCount, isArchived, ratingCount }),
      tags,
      date_added: group.lastSeenAt ?? followedAt ?? new Date().toISOString(),
      published: true,
    });
  }

  return items;
}

function buildMovieItems(files, includeQueued) {
  const groups = new Map();
  for (const row of files.trackingRecords) {
    if (clean(row.entity_type) !== "movie") continue;
    const title = clean(row.movie_name);
    if (!title) continue;

    const key = clean(row.uuid) || normalizeTitleKey(title);
    const group = groups.get(key) ?? {
      title,
      uuid: clean(row.uuid),
      watched: false,
      queued: false,
      followed: false,
      watchCount: 0,
      rewatchCount: 0,
      runtimeSeconds: null,
      releaseDate: null,
      watchedAt: null,
      followedAt: null,
      queuedAt: null,
    };

    const type = clean(row.type);
    if (type === "watch") {
      group.watched = true;
      group.watchCount += 1;
      group.watchedAt = maxDate(group.watchedAt, safeIsoDate(row.watch_date) ?? safeIsoDate(row.created_at));
    } else if (type === "towatch") {
      group.queued = true;
      group.queuedAt = maxDate(group.queuedAt, safeIsoDate(row.created_at));
    } else if (type === "follow") {
      group.followed = true;
      group.followedAt = maxDate(group.followedAt, safeIsoDate(row.created_at));
    } else if (type === "rewatch_count") {
      group.rewatchCount = Math.max(group.rewatchCount, parseInteger(row.rewatch_count) ?? 0);
    }

    group.runtimeSeconds = group.runtimeSeconds ?? parseInteger(row.runtime);
    group.releaseDate = group.releaseDate ?? safeIsoDate(row.release_date);
    groups.set(key, group);
  }

  const items = [];
  for (const group of groups.values()) {
    if (!group.watched && !(includeQueued && group.queued)) continue;

    const status = group.watched ? "watched" : "queued";
    const tags = compact([
      "source:tv-time",
      "kind:movie",
      `status:${status}`,
      `watched:${group.watched ? "true" : "false"}`,
      group.queued ? "queued:true" : null,
      group.followed ? "followed:true" : null,
      group.watchCount ? `watch_count:${group.watchCount}` : null,
      group.rewatchCount ? `rewatch_count:${group.rewatchCount}` : null,
      group.runtimeSeconds ? `runtime_seconds:${group.runtimeSeconds}` : null,
      group.releaseDate ? `year:${dateOnly(group.releaseDate).slice(0, 4)}` : null,
      group.watchedAt ? `watched_at:${dateOnly(group.watchedAt)}` : null,
      group.queuedAt && !group.watched ? `queued_at:${dateOnly(group.queuedAt)}` : null,
      group.uuid ? `tv_time_uuid:${group.uuid}` : null,
    ]);

    items.push({
      type: "movie",
      title: group.title,
      source: "TV Time",
      drawer: "movies",
      note: buildMovieNote(group),
      tags,
      date_added: group.watchedAt ?? group.queuedAt ?? group.followedAt ?? group.releaseDate ?? new Date().toISOString(),
      published: true,
    });
  }

  return items;
}

function buildShowNote({ episodeCount, seasonCount, isArchived, ratingCount }) {
  const parts = [`Watched ${pluralize(episodeCount, "episode")}`];
  if (seasonCount) parts.push(`across ${pluralize(seasonCount, "season")}`);
  if (ratingCount) parts.push(`${pluralize(ratingCount, "rated episode")}`);
  if (isArchived) parts.push("archived in TV Time");
  return `${parts.join(", ")}. Imported from TV Time.`;
}

function buildMovieNote(group) {
  const parts = [];
  if (group.watched) parts.push("Watched");
  else if (group.queued) parts.push("Queued");
  if (group.releaseDate) parts.push(`released ${dateOnly(group.releaseDate).slice(0, 4)}`);
  if (group.runtimeSeconds) parts.push(`${Math.round(group.runtimeSeconds / 60)} min`);
  if (group.rewatchCount) parts.push(`${group.rewatchCount} rewatches`);
  return `${parts.join(", ")}. Imported from TV Time.`;
}

function compareShelfItems(left, right) {
  const dateCompare = Date.parse(right.date_added) - Date.parse(left.date_added);
  if (Number.isFinite(dateCompare) && dateCompare !== 0) return dateCompare;
  return String(left.title).localeCompare(String(right.title));
}

async function checkExistingItems({ apiBaseUrl, apiToken, items }) {
  const existing = await fetchExistingShelfItems(apiBaseUrl, apiToken);
  const existingKeys = new Set(existing.map((item) => shelfKey(item)));
  const matches = items.filter((item) => existingKeys.has(shelfKey(item)));
  return {
    api_url: apiBaseUrl,
    existing_shelf_items: existing.length,
    matching_items: matches.map((item) => ({
      type: item.type,
      title: item.title,
    })),
  };
}

async function commitItems({ apiBaseUrl, apiToken, items }) {
  const existing = await fetchExistingShelfItems(apiBaseUrl, apiToken);
  const existingKeys = new Set(existing.map((item) => shelfKey(item)));
  const result = {
    api_url: apiBaseUrl,
    created: [],
    skipped_existing: [],
    failed: [],
  };

  for (const item of items) {
    const key = shelfKey(item);
    if (existingKeys.has(key)) {
      result.skipped_existing.push({ type: item.type, title: item.title });
      continue;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/v1/shelf`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(item),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${bodyText.slice(0, 300)}`);
      }
      result.created.push({ type: item.type, title: item.title });
      existingKeys.add(key);
      await delay(COMMIT_DELAY_MS);
    } catch (error) {
      result.failed.push({
        type: item.type,
        title: item.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function fetchExistingShelfItems(apiBaseUrl, apiToken) {
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${apiBaseUrl}/v1/shelf`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("include_unpublished", "true");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to fetch existing shelf items: ${response.status} ${response.statusText}: ${bodyText.slice(0, 300)}`);
    }

    const page = JSON.parse(bodyText);
    if (!Array.isArray(page)) {
      throw new Error("Expected /v1/shelf to return an array.");
    }
    items.push(...page);
    if (page.length < 1000) break;
  }
  return items;
}

function shelfKey(item) {
  return `${clean(item.type)}:${normalizeTitleKey(item.title)}`;
}

function normalizeApiBaseUrl(value) {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function mergeFirst(target, key, value) {
  if (!target[key] && value) {
    target[key] = value;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeTitleKey(value) {
  return clean(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseInteger(value) {
  const number = Number.parseInt(clean(value), 10);
  return Number.isFinite(number) ? number : null;
}

function booleanish(value) {
  const normalized = clean(value).toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  return null;
}

function safeIsoDate(value) {
  const raw = clean(value);
  if (!raw) return null;

  const yearMatch = /^(\d{4})/.exec(raw);
  if (!yearMatch) return null;

  const year = Number(yearMatch[1]);
  if (year < 1900 || year > 2100) return null;

  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const date = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function minDate(left, right) {
  if (!right) return left;
  if (!left) return right;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function maxDate(left, right) {
  if (!right) return left;
  if (!left) return right;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function dateOnly(value) {
  return value.slice(0, 10);
}

function compact(values) {
  return values.filter((value) => typeof value === "string" && value.length > 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function pluralize(value, noun) {
  return `${formatNumber(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
