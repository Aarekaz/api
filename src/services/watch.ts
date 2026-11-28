import type { Env } from "../types/env";
import { HttpError } from "../lib/http";
import { getTag } from "../utils/tags";
import {
  findTmdbByExternalId,
  getTmdbSeason,
  getTmdbTitle,
  tmdbPosterUrl,
  type TmdbEpisodeRef,
  type TmdbMediaType,
  type TmdbTitle,
  type TmdbTvSeason,
} from "./tmdb";

// Films and shows: what you've watched, episode by episode, on top of the shelf.
// shelf_items is the title on your shelf (the website reads it), media_watches
// holds every viewing, media_titles / media_episodes keep TMDB's details.
// See migrations/0060_watch.sql.

const DAY_MS = 86_400_000;
/** Shows still airing are refreshed weekly; everything else within TMDB's six months. */
const AIRING_TTL_MS = 7 * DAY_MS;
const SETTLED_TTL_MS = 150 * DAY_MS;
const AIRING = new Set(["Returning Series", "In Production", "Planned", "Pilot"]);
/** Typical lengths when TMDB doesn't say, for hours watched. */
const FALLBACK_MINUTES = { film: 110, episode: 40 };

export const WATCH_TYPES = ["movie", "show", "anime"] as const;
export type WatchType = (typeof WATCH_TYPES)[number];

const now = () => new Date().toISOString();
const todayDay = () => new Date().toISOString().slice(0, 10);

function json<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A date or a moment, as an ISO instant. A bare day is noon UTC, so it stays that day almost everywhere. */
export function toInstant(value: string | undefined | null, fallback = now()): string {
  if (!value) return fallback;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T12:00:00.000Z`;
  const parsed = Date.parse(text.includes("T") || text.includes("Z") ? text : text.replace(" ", "T") + "Z");
  if (!Number.isFinite(parsed)) throw new HttpError(400, `Not a date: ${value}`);
  return new Date(parsed).toISOString();
}

export const mediaTypeFor = (type: string): TmdbMediaType => (type === "movie" ? "movie" : "tv");

// ---------------------------------------------------------------------------
// TMDB cache

type TitleRow = {
  media_type: TmdbMediaType;
  tmdb_id: number;
  title: string;
  original_title: string | null;
  year: string | null;
  release_date: string | null;
  runtime: number | null;
  genres_json: string | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  status: string | null;
  seasons_json: string | null;
  next_episode_json: string | null;
  last_air_date: string | null;
  imdb_id: string | null;
  tvdb_id: number | null;
  refreshed_at: string;
};

function stale(row: Pick<TitleRow, "status" | "refreshed_at">, at = Date.now()): boolean {
  const age = at - Date.parse(row.refreshed_at);
  return !(age >= 0) || age > (AIRING.has(row.status ?? "") ? AIRING_TTL_MS : SETTLED_TTL_MS);
}

async function readTitle(env: Env, type: TmdbMediaType, tmdbId: number): Promise<TitleRow | null> {
  return env.DB.prepare("SELECT * FROM media_titles WHERE media_type = ? AND tmdb_id = ?").bind(type, tmdbId).first<TitleRow>();
}

/**
 * TMDB's details for a title, from the cache while fresh. With `episodes`, a
 * show's episode list is filled too. Returns null when TMDB has no such title.
 */
export async function cachedTitle(
  env: Env,
  type: TmdbMediaType,
  tmdbId: number,
  options: { episodes?: boolean; force?: boolean } = {},
): Promise<TitleRow | null> {
  const row = await readTitle(env, type, tmdbId);
  const needEpisodes = options.episodes && type === "tv";
  if (row && !options.force && !stale(row)) {
    if (!needEpisodes) return row;
    const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM media_episodes WHERE tmdb_id = ?").bind(tmdbId).first<{ n: number }>();
    if ((have?.n ?? 0) > 0) return row;
  }
  const fresh = await getTmdbTitle(env, type, tmdbId);
  if (!fresh) return row;
  await saveTitle(env, fresh);
  if (needEpisodes || (type === "tv" && row)) await saveEpisodes(env, fresh);
  return readTitle(env, type, tmdbId);
}

async function saveTitle(env: Env, title: TmdbTitle): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO media_titles (media_type, tmdb_id, title, original_title, year, release_date, runtime, genres_json, overview,
       poster_path, backdrop_path, status, seasons_json, next_episode_json, last_air_date, imdb_id, tvdb_id, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (media_type, tmdb_id) DO UPDATE SET title = excluded.title, original_title = excluded.original_title,
       year = excluded.year, release_date = excluded.release_date, runtime = excluded.runtime, genres_json = excluded.genres_json,
       overview = excluded.overview, poster_path = excluded.poster_path, backdrop_path = excluded.backdrop_path,
       status = excluded.status, seasons_json = excluded.seasons_json, next_episode_json = excluded.next_episode_json,
       last_air_date = excluded.last_air_date, imdb_id = excluded.imdb_id, tvdb_id = excluded.tvdb_id,
       refreshed_at = excluded.refreshed_at`,
  )
    .bind(
      title.media_type, title.tmdb_id, title.title, title.original_title ?? null, title.year ?? null, title.release_date ?? null,
      title.runtime ?? null, JSON.stringify(title.genres), title.overview ?? null, title.poster_path ?? null,
      title.backdrop_path ?? null, title.status ?? null, JSON.stringify(title.seasons),
      title.next_episode ? JSON.stringify(title.next_episode) : null, title.last_air_date ?? null, title.imdb_id ?? null,
      title.tvdb_id ?? null, now(),
    )
    .run();
}

async function saveEpisodes(env: Env, title: TmdbTitle): Promise<void> {
  if (title.media_type !== "tv" || !title.seasons.length) return;
  const seasons = await Promise.all(title.seasons.map((season) => getTmdbSeason(env, title.tmdb_id, season.season_number)));
  const at = now();
  const statements = seasons.flat().map((episode) =>
    env.DB.prepare(
      `INSERT INTO media_episodes (tmdb_id, season, episode, name, air_date, runtime, still_path, overview, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tmdb_id, season, episode) DO UPDATE SET name = excluded.name, air_date = excluded.air_date,
         runtime = excluded.runtime, still_path = excluded.still_path, overview = excluded.overview, refreshed_at = excluded.refreshed_at`,
    ).bind(title.tmdb_id, episode.season, episode.episode, episode.name ?? null, episode.air_date ?? null,
      episode.runtime ?? null, episode.still_path ?? null, episode.overview ?? null, at),
  );
  for (let index = 0; index < statements.length; index += 80) await env.DB.batch(statements.slice(index, index + 80));
}

/** The cron's share of refreshing: a few of the stalest titles per tick. */
export async function refreshStaleTitles(env: Env, limit = 4): Promise<number> {
  const airing = [...AIRING].map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT media_type, tmdb_id FROM media_titles
     WHERE (status IN (${airing}) AND refreshed_at < ?) OR refreshed_at < ?
     ORDER BY refreshed_at LIMIT ?`,
  )
    .bind(...AIRING, new Date(Date.now() - AIRING_TTL_MS).toISOString(), new Date(Date.now() - SETTLED_TTL_MS).toISOString(), limit)
    .all<{ media_type: TmdbMediaType; tmdb_id: number }>();
  for (const row of results ?? []) await cachedTitle(env, row.media_type, row.tmdb_id, { force: true });
  return results?.length ?? 0;
}

// ---------------------------------------------------------------------------
// The library

type ItemRow = {
  id: number;
  type: string;
  title: string | null;
  image_url: string | null;
  cover_override_url: string | null;
  status: string | null;
  tags_json: string | null;
  metadata_json: string | null;
  rating: number | null;
  rating_scale: number | null;
  published: number | null;
  date_added: string | null;
  created_at: string | null;
  note: string | null;
  link_type: TmdbMediaType | null;
  link_id: number | null;
} & Partial<Omit<TitleRow, "media_type" | "tmdb_id" | "title" | "status">> & { tmdb_status?: string | null };

type WatchRow = {
  id: number;
  item_id: number;
  season: number | null;
  episode: number | null;
  watched_at: string;
  run: number;
  rating: number | null;
  skipped: number;
  source: string;
  note: string | null;
};

const ITEM_SELECT = `SELECT s.id, s.type, s.title, s.image_url, s.cover_override_url, s.status, s.tags_json, s.metadata_json, s.rating,
    s.rating_scale, s.published, s.date_added, s.created_at, s.note,
    l.media_type AS link_type, l.tmdb_id AS link_id, t.year, t.release_date, t.runtime, t.genres_json, t.overview, t.poster_path,
    t.backdrop_path, t.status AS tmdb_status, t.seasons_json, t.next_episode_json, t.last_air_date, t.refreshed_at
  FROM shelf_items s
  LEFT JOIN media_links l ON l.item_id = s.id
  LEFT JOIN media_titles t ON t.media_type = l.media_type AND t.tmdb_id = l.tmdb_id`;

const TYPE_FILTER = `s.type IN ('movie', 'show', 'anime')`;

/** The shelf's status, or for old imports a `status:` tag that fits the type. */
function statusOf(row: Pick<ItemRow, "status" | "tags_json" | "type">): string | null {
  if (row.status) return row.status;
  let tag = getTag(json(row.tags_json, []), "status");
  if (!tag) return null;
  if (tag === "watched" && row.type !== "movie") tag = "completed";
  const allowed = row.type === "movie" ? ["watched", "watching", "want_to_watch"] : ["watching", "completed", "want_to_watch", "paused", "dropped"];
  return allowed.includes(tag) ? tag : null;
}

type Progress = {
  run: number;
  watched: number;
  skipped: number;
  total: number | null;
  aired: number | null;
  season: number | null;
  episode: number | null;
  next: (TmdbEpisodeRef & { aired: boolean }) | null;
};

/** Where you are in a show: the furthest episode of the current run, and the one after it. */
function progressOf(seasons: TmdbTvSeason[], nextToAir: TmdbEpisodeRef | null, watches: WatchRow[]): Progress {
  const episodes = watches.filter((watch) => watch.season != null && watch.episode != null);
  const run = episodes.reduce((max, watch) => Math.max(max, watch.run), 0);
  const current = episodes.filter((watch) => watch.run === run);
  const seen = new Set(current.map((watch) => `${watch.season}:${watch.episode}`));
  const skipped = new Set(current.filter((watch) => watch.skipped).map((watch) => `${watch.season}:${watch.episode}`));
  const total = seasons.length ? seasons.reduce((sum, season) => sum + season.episode_count, 0) : null;

  // Episodes aired so far: everything before TMDB's next-to-air, else all of them.
  let aired = total;
  if (total != null && nextToAir) {
    aired = seasons.filter((season) => season.season_number < nextToAir.season_number).reduce((sum, season) => sum + season.episode_count, 0)
      + nextToAir.episode_number - 1;
  }

  let furthest: { season: number; episode: number } | null = null;
  for (const watch of current) {
    const at = { season: watch.season as number, episode: watch.episode as number };
    if (!furthest || at.season > furthest.season || (at.season === furthest.season && at.episode > furthest.episode)) furthest = at;
  }

  let next: TmdbEpisodeRef | null = null;
  if (!furthest) {
    next = seasons.length ? { season_number: seasons[0].season_number, episode_number: 1 } : { season_number: 1, episode_number: 1 };
  } else if (seasons.length) {
    const index = seasons.findIndex((season) => season.season_number === furthest!.season);
    const season = seasons[index];
    if (season && furthest.episode < season.episode_count) next = { season_number: furthest.season, episode_number: furthest.episode + 1 };
    else if (seasons[index + 1]) next = { season_number: seasons[index + 1].season_number, episode_number: 1 };
    else if (nextToAir && (nextToAir.season_number > furthest.season || nextToAir.episode_number > furthest.episode)) next = nextToAir;
  } else {
    next = { season_number: furthest.season, episode_number: furthest.episode + 1 };
  }

  let nextAired = true;
  if (next && nextToAir) {
    nextAired = next.season_number < nextToAir.season_number
      || (next.season_number === nextToAir.season_number && next.episode_number < nextToAir.episode_number);
    if (!nextAired && next.season_number === nextToAir.season_number && next.episode_number === nextToAir.episode_number) {
      next = { ...nextToAir };
    }
  }
  return {
    run,
    watched: [...seen].filter((key) => !skipped.has(key)).length,
    skipped: skipped.size,
    total,
    aired,
    season: furthest?.season ?? null,
    episode: furthest?.episode ?? null,
    next: next ? { ...next, aired: nextAired } : null,
  };
}

export type WatchItem = ReturnType<typeof shapeItem>;

function shapeItem(row: ItemRow, watches: WatchRow[]) {
  const seasons = json<TmdbTvSeason[]>(row.seasons_json, []);
  const nextToAir = json<TmdbEpisodeRef | null>(row.next_episode_json, null);
  const films = watches.filter((watch) => watch.season == null);
  const dates = watches.filter((watch) => !watch.skipped).map((watch) => watch.watched_at).sort();
  const rating = row.rating && row.rating > 0 ? ((row.rating_scale ?? 5) === 10 ? row.rating / 2 : row.rating) : null;
  const poster = row.cover_override_url || tmdbPosterUrl(row.poster_path) || row.image_url || null;
  const isFilm = row.type === "movie";
  return {
    id: row.id,
    type: row.type,
    title: row.title ?? "Untitled",
    year: row.year ?? getTag(json(row.tags_json, []), "year") ?? null,
    status: statusOf(row),
    rating,
    published: row.published == null ? true : row.published === 1,
    note: row.note,
    poster_url: poster,
    backdrop_url: tmdbPosterUrl(row.backdrop_path, "w1280") ?? null,
    runtime: row.runtime ?? (isFilm ? minutesFromTags(row.tags_json) : null),
    genres: json<string[]>(row.genres_json, []),
    overview: row.overview ?? null,
    tmdb: row.link_id ? { media_type: row.link_type, id: row.link_id, status: row.tmdb_status ?? null } : null,
    added_at: row.date_added ?? row.created_at,
    first_watched_at: dates[0] ?? null,
    last_watched_at: dates[dates.length - 1] ?? null,
    views: isFilm ? films.length : null,
    seasons: seasons.map((season) => ({ number: season.season_number, episodes: season.episode_count, air_date: season.air_date ?? null })),
    progress: isFilm ? null : progressOf(seasons, nextToAir, watches),
    next_air: nextToAir,
  };
}

function minutesFromTags(tags: string | null): number | null {
  const seconds = Number(getTag(json(tags, []), "runtime_seconds"));
  return seconds > 0 ? Math.round(seconds / 60) : null;
}

/** Every film and show with where it stands, in one read. */
export async function library(env: Env) {
  const [items, watches] = await env.DB.batch([
    env.DB.prepare(`${ITEM_SELECT} WHERE ${TYPE_FILTER} ORDER BY s.id`),
    env.DB.prepare(`SELECT w.id, w.item_id, w.season, w.episode, w.watched_at, w.run, w.rating, w.skipped, w.source, w.note
      FROM media_watches w JOIN shelf_items s ON s.id = w.item_id WHERE ${TYPE_FILTER}`),
  ]);
  const byItem = new Map<number, WatchRow[]>();
  for (const watch of (watches.results ?? []) as WatchRow[]) {
    const list = byItem.get(watch.item_id) ?? [];
    list.push(watch);
    byItem.set(watch.item_id, list);
  }
  return ((items.results ?? []) as ItemRow[]).map((row) => shapeItem(row, byItem.get(row.id) ?? []));
}

async function itemRow(env: Env, itemId: number): Promise<ItemRow> {
  const row = await env.DB.prepare(`${ITEM_SELECT} WHERE s.id = ? AND ${TYPE_FILTER}`).bind(itemId).first<ItemRow>();
  if (!row) throw new HttpError(404, "No film or show with that id");
  return row;
}

async function watchesFor(env: Env, itemId: number): Promise<WatchRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, item_id, season, episode, watched_at, run, rating, skipped, source, note FROM media_watches WHERE item_id = ? ORDER BY watched_at, id",
  ).bind(itemId).all<WatchRow>();
  return results ?? [];
}

/** One item, linking it to TMDB from its tags on first sight. */
async function linkedItem(env: Env, itemId: number, options: { episodes?: boolean } = {}): Promise<ItemRow> {
  let row = await itemRow(env, itemId);
  if (!row.link_id) {
    const tags = json(row.tags_json, []);
    const tmdbId = Number(getTag(tags, "tmdb_id"));
    if (tmdbId > 0) {
      await link(env, itemId, mediaTypeFor(row.type), tmdbId);
      row = await itemRow(env, itemId);
    }
  }
  if (row.link_id && row.link_type && (!row.refreshed_at || options.episodes)) {
    await cachedTitle(env, row.link_type, row.link_id, { episodes: options.episodes });
    row = await itemRow(env, itemId);
  }
  return row;
}

async function link(env: Env, itemId: number, type: TmdbMediaType, tmdbId: number) {
  await env.DB.prepare(
    `INSERT INTO media_links (item_id, media_type, tmdb_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET media_type = excluded.media_type, tmdb_id = excluded.tmdb_id`,
  ).bind(itemId, type, tmdbId, now()).run();
}

/** A title's page: details, every episode (for the season grid) and every viewing. */
export async function titleDetail(env: Env, itemId: number) {
  const row = await linkedItem(env, itemId, { episodes: true });
  const watches = await watchesFor(env, itemId);
  const episodes = row.link_type === "tv" && row.link_id
    ? ((await env.DB.prepare(
        "SELECT season, episode, name, air_date, runtime, still_path, overview FROM media_episodes WHERE tmdb_id = ? ORDER BY season, episode",
      ).bind(row.link_id).all<{ season: number; episode: number; name: string | null; air_date: string | null; runtime: number | null; still_path: string | null; overview: string | null }>()).results ?? [])
    : [];
  return {
    ...shapeItem(row, watches),
    episodes: episodes.map((episode) => ({
      season: episode.season,
      episode: episode.episode,
      name: episode.name,
      air_date: episode.air_date,
      runtime: episode.runtime,
      still_url: tmdbPosterUrl(episode.still_path, "w300") ?? null,
      overview: episode.overview,
    })),
    watches: watches.map(shapeWatch),
  };
}

const shapeWatch = (watch: WatchRow) => ({
  id: watch.id,
  season: watch.season,
  episode: watch.episode,
  watched_at: watch.watched_at,
  run: watch.run,
  rating: watch.rating,
  skipped: watch.skipped === 1,
  source: watch.source,
  note: watch.note,
});

// ---------------------------------------------------------------------------
// Adding titles

export type AddInput = {
  media_type?: TmdbMediaType;
  tmdb_id?: number;
  tvdb_id?: number;
  imdb_id?: string;
  status?: string;
  published?: boolean;
  added_at?: string;
  source?: string;
  tags?: string[];
};

/** Puts a TMDB title on the shelf (or finds it already there). */
export async function addTitle(env: Env, input: AddInput): Promise<{ item: WatchItem; created: boolean }> {
  let type = input.media_type;
  let tmdbId = input.tmdb_id;
  if (!tmdbId && (input.tvdb_id || input.imdb_id)) {
    const found = input.tvdb_id
      ? await findTmdbByExternalId(env, "tvdb_id", String(input.tvdb_id))
      : await findTmdbByExternalId(env, "imdb_id", input.imdb_id!);
    if (!found) throw new HttpError(404, "TMDB has no title with that id");
    type = found.media_type;
    tmdbId = found.tmdb_id;
  }
  if (!type || !tmdbId) throw new HttpError(400, "Send tmdb_id with media_type, or a tvdb_id or imdb_id");

  const existing = await env.DB.prepare("SELECT item_id FROM media_links WHERE media_type = ? AND tmdb_id = ? ORDER BY item_id LIMIT 1")
    .bind(type, tmdbId).first<{ item_id: number }>();
  if (existing) return { item: shapeItem(await itemRow(env, existing.item_id), await watchesFor(env, existing.item_id)), created: false };

  const title = await cachedTitle(env, type, tmdbId);
  if (!title) throw new HttpError(404, "TMDB has no title with that id");
  const shelfType = type === "movie" ? "movie" : "show";
  const status = input.status ?? null;
  const allowed = shelfType === "movie" ? ["watched", "watching", "want_to_watch"] : ["watching", "completed", "want_to_watch", "paused", "dropped"];
  if (status && !allowed.includes(status)) throw new HttpError(400, `A ${shelfType} can't be "${status}"`);

  const at = now();
  const tags = [
    ...(input.source ? [`source:${input.source}`] : []),
    `kind:${shelfType}`,
    ...(title.year ? [`year:${title.year}`] : []),
    `tmdb_id:${tmdbId}`,
    `tmdb_media_type:${type}`,
    "poster_source:tmdb",
    ...(input.tags ?? []),
  ];
  const metadata = {
    tmdb: { id: tmdbId, media_type: type, title: title.title, year: title.year, overview: title.overview,
      poster_path: title.poster_path, poster_url: tmdbPosterUrl(title.poster_path), backdrop_path: title.backdrop_path },
    ...(type === "tv" ? { seasons: json<TmdbTvSeason[]>(title.seasons_json, []).map((season) => season.episode_count) } : {}),
  };
  const inserted = await env.DB.prepare(
    `INSERT INTO shelf_items (type, title, image_url, drawer, tags_json, date_added, published, status, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(
    shelfType, title.title, tmdbPosterUrl(title.poster_path) ?? null, shelfType === "movie" ? "movies" : "shows", JSON.stringify(tags),
    input.added_at ? toInstant(input.added_at) : at, input.published === true ? 1 : 0, status, JSON.stringify(metadata), at, at,
  ).first<{ id: number }>();
  if (!inserted) throw new HttpError(500, "Couldn't add the title");
  await link(env, inserted.id, type, tmdbId);
  return { item: shapeItem(await itemRow(env, inserted.id), []), created: true };
}

// ---------------------------------------------------------------------------
// Logging

export type EpisodeMark = { season: number; episode: number; watched_at?: string; source_key?: string; skipped?: boolean; rating?: number };

export type MarkInput = {
  episodes?: EpisodeMark[];
  /** Everything up to and including this episode that isn't watched yet in this run ("mark all previous"). */
  up_to?: { season: number; episode: number };
  watched_at?: string;
  /** Start a rewatch: these marks open a new run. */
  rewatch?: boolean;
  /** Older viewings (an import) don't move the shelf item or write the diary. */
  update_item?: boolean;
  source?: string;
  /** Imports: which run the marks belong to (TV Time's rewatches are run 1). */
  run?: number;
};

/** Marks episodes watched (or skipped). Returns the title as it now stands. */
export async function markEpisodes(env: Env, itemId: number, input: MarkInput) {
  const row = await linkedItem(env, itemId);
  if (row.type === "movie") throw new HttpError(400, "A film is logged with POST /v1/watch/films/{id}/watched");
  const watches = await watchesFor(env, itemId);
  const before = progressOf(json(row.seasons_json, []), json(row.next_episode_json, null), watches);
  const run = input.run ?? (input.rewatch ? before.run + 1 : before.run);
  const seen = new Set(watches.filter((watch) => watch.run === run && watch.season != null).map((watch) => `${watch.season}:${watch.episode}`));
  const fallbackAt = toInstant(input.watched_at);

  const marks: EpisodeMark[] = [...(input.episodes ?? [])];
  if (input.up_to) {
    const seasons = json<TmdbTvSeason[]>(row.seasons_json, []);
    if (!seasons.length) throw new HttpError(409, "This show's seasons aren't known yet; mark episodes one by one");
    for (const season of seasons) {
      if (season.season_number > input.up_to.season) break;
      const last = season.season_number === input.up_to.season ? Math.min(input.up_to.episode, season.episode_count) : season.episode_count;
      for (let episode = 1; episode <= last; episode++) marks.push({ season: season.season_number, episode });
    }
  }
  if (!marks.length) throw new HttpError(400, "Send episodes or up_to");

  const at = now();
  const source = input.source ?? "app";
  const statements = marks
    .filter((mark) => mark.source_key || !seen.has(`${mark.season}:${mark.episode}`))
    .map((mark) => {
      if (!(mark.season >= 0) || !(mark.episode > 0)) throw new HttpError(400, "Episodes need a season and an episode number");
      return env.DB.prepare(
        `INSERT OR IGNORE INTO media_watches (item_id, season, episode, watched_at, run, rating, skipped, source, source_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(itemId, mark.season, mark.episode, mark.watched_at ? toInstant(mark.watched_at) : fallbackAt, run,
        mark.rating ?? null, mark.skipped ? 1 : 0, source, mark.source_key ?? null, at);
    });
  let added = 0;
  for (let index = 0; index < statements.length; index += 80) {
    const results = await env.DB.batch(statements.slice(index, index + 80));
    added += results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
  }
  if (input.update_item !== false && added > 0) await settleShow(env, itemId, before);
  return { added, item: await titleDetail(env, itemId) };
}

/** Takes back viewings by id (an episode marked by mistake). */
export async function unmark(env: Env, itemId: number, ids: number[]) {
  await itemRow(env, itemId);
  if (!ids.length) throw new HttpError(400, "Send the viewings' ids");
  const holes = ids.map(() => "?").join(", ");
  const result = await env.DB.prepare(`DELETE FROM media_watches WHERE item_id = ? AND id IN (${holes})`).bind(itemId, ...ids).run();
  const row = await itemRow(env, itemId);
  if (row.type !== "movie") await settleShow(env, itemId, null);
  return { removed: result.meta?.changes ?? 0, item: await titleDetail(env, itemId) };
}

/** Moves a show's shelf row (status, progress, dates) to match its viewings, and writes the diary's milestones. */
async function settleShow(env: Env, itemId: number, before: Progress | null) {
  const row = await itemRow(env, itemId);
  const watches = await watchesFor(env, itemId);
  const progress = progressOf(json(row.seasons_json, []), json(row.next_episode_json, null), watches);
  const current = watches.filter((watch) => watch.run === progress.run && !watch.skipped && watch.season != null);
  const first = current[0]?.watched_at ?? null;
  const last = current[current.length - 1]?.watched_at ?? null;
  const ended = ["Ended", "Canceled"].includes(row.tmdb_status ?? "");
  const caughtUp = progress.aired != null && progress.watched + progress.skipped >= progress.aired && progress.watched > 0;
  const status = caughtUp && ended ? "completed" : progress.watched > 0 ? "watching" : statusOf(row);
  const metadata = json<Record<string, unknown>>(row.metadata_json, {});
  if (progress.season != null) metadata.progress = { season: progress.season, episode: progress.episode };
  const seasons = json<TmdbTvSeason[]>(row.seasons_json, []);
  if (seasons.length) metadata.seasons = seasons.map((season) => season.episode_count);

  const at = now();
  const statements = [
    env.DB.prepare(
      `UPDATE shelf_items SET status = ?, progress_current = ?, progress_total = ?, progress_unit = 'episode',
         started_at = COALESCE(started_at, ?), last_watched_at = ?, completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END,
         metadata_json = ?, updated_at = ? WHERE id = ?`,
    ).bind(status, progress.watched, progress.total, first, last, status, last, JSON.stringify(metadata), at, itemId),
  ];
  const diary = (kind: string, when: string) =>
    env.DB.prepare(
      `INSERT INTO shelf_log (item_id, kind, logged_at, status, progress_current, progress_total, progress_unit, season, episode, rewatch, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'episode', ?, ?, ?, ?)`,
    ).bind(itemId, kind, when, status, progress.watched, progress.total, progress.season, progress.episode, progress.run > 0 ? 1 : 0, at);
  if (before && (before.watched === 0 || before.run !== progress.run) && progress.watched > 0 && first) statements.push(diary("started", first));
  if (before && status === "completed" && statusOf(row) !== "completed" && last) statements.push(diary("finished", last));
  await env.DB.batch(statements);
}

export type FilmInput = { watched_at?: string; rating?: number | null; note?: string; source?: string; source_key?: string; update_item?: boolean };

/** One viewing of a film. A second viewing is a rewatch by itself. */
export async function logFilm(env: Env, itemId: number, input: FilmInput) {
  const row = await linkedItem(env, itemId);
  if (row.type !== "movie") throw new HttpError(400, "Shows are logged by episode: POST /v1/watch/titles/{id}/episodes");
  if (input.rating != null && !(input.rating >= 0.5 && input.rating <= 5 && Number.isInteger(input.rating * 2))) {
    throw new HttpError(400, "A rating is 0.5 to 5, in halves");
  }
  const watches = await watchesFor(env, itemId);
  const run = watches.length ? Math.max(...watches.map((watch) => watch.run)) + 1 : 0;
  const when = toInstant(input.watched_at);
  const at = now();
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO media_watches (item_id, watched_at, run, rating, source, source_key, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(itemId, when, run, input.rating ?? null, input.source ?? "app", input.source_key ?? null, input.note ?? null, at).run();
  if ((insert.meta?.changes ?? 0) > 0 && input.update_item !== false) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE shelf_items SET status = 'watched', completed_at = COALESCE(completed_at, ?),
           last_watched_at = CASE WHEN last_watched_at IS NULL OR last_watched_at < ? THEN ? ELSE last_watched_at END,
           rating = COALESCE(?, rating), rating_scale = CASE WHEN ? IS NULL THEN rating_scale ELSE 5 END, updated_at = ? WHERE id = ?`,
      ).bind(when, when, when, input.rating ?? null, input.rating ?? null, at, itemId),
      env.DB.prepare(
        `INSERT INTO shelf_log (item_id, kind, logged_at, status, rating, note, rewatch, created_at)
         VALUES (?, 'finished', ?, 'watched', ?, ?, ?, ?)`,
      ).bind(itemId, when, input.rating ?? null, input.note ?? null, run > 0 ? 1 : 0, at),
    ]);
  }
  return { added: insert.meta?.changes ?? 0, item: await titleDetail(env, itemId) };
}

// ---------------------------------------------------------------------------
// Up next, coming back, stats, picks

/** The next episode of every show you're in the middle of, newest activity first. */
export async function upNext(env: Env) {
  const items = (await library(env)).filter(
    (item) => item.progress && item.progress.next && item.progress.watched > 0 && (item.status === "watching" || item.status == null),
  );
  items.sort((a, b) => (b.last_watched_at ?? "").localeCompare(a.last_watched_at ?? ""));
  const names = await Promise.all(items.map((item) =>
    item.tmdb?.id
      ? env.DB.prepare("SELECT name, air_date, runtime, still_path FROM media_episodes WHERE tmdb_id = ? AND season = ? AND episode = ?")
          .bind(item.tmdb.id, item.progress!.next!.season_number, item.progress!.next!.episode_number)
          .first<{ name: string | null; air_date: string | null; runtime: number | null; still_path: string | null }>()
      : Promise.resolve(null)));
  return items.map((item, index) => ({
    item,
    episode: {
      season: item.progress!.next!.season_number,
      episode: item.progress!.next!.episode_number,
      name: names[index]?.name ?? item.progress!.next!.name ?? null,
      air_date: names[index]?.air_date ?? item.progress!.next!.air_date ?? null,
      runtime: names[index]?.runtime ?? item.runtime,
      still_url: tmdbPosterUrl(names[index]?.still_path, "w780") ?? null,
      aired: item.progress!.next!.aired,
      left: item.progress!.aired != null ? Math.max(0, item.progress!.aired - item.progress!.watched - item.progress!.skipped) : null,
    },
  }));
}

/** Shows you follow with a date for their next episode, soonest first. */
export async function comingBack(env: Env) {
  const today = todayDay();
  return (await library(env))
    .filter((item) => item.type !== "movie" && item.next_air?.air_date && item.next_air.air_date >= today
      && item.status !== "dropped" && item.status !== "want_to_watch" && (item.progress?.watched ?? 0) > 0)
    .map((item) => ({ item, episode: item.next_air! }))
    .sort((a, b) => (a.episode.air_date ?? "").localeCompare(b.episode.air_date ?? ""));
}

/** A year (or all time) in numbers: films, episodes, hours, by month, genres, most-watched shows. */
export async function stats(env: Env, year?: number) {
  const from = year ? `${year}-01-01` : "0000";
  const to = year ? `${year + 1}-01-01` : "9999";
  const { results } = await env.DB.prepare(
    `SELECT w.item_id, w.season, w.watched_at, w.run, s.type, s.title,
            COALESCE(e.runtime, t.runtime) AS minutes, t.genres_json
     FROM media_watches w
     JOIN shelf_items s ON s.id = w.item_id
     LEFT JOIN media_links l ON l.item_id = w.item_id
     LEFT JOIN media_titles t ON t.media_type = l.media_type AND t.tmdb_id = l.tmdb_id
     LEFT JOIN media_episodes e ON e.tmdb_id = l.tmdb_id AND e.season = w.season AND e.episode = w.episode AND l.media_type = 'tv'
     WHERE w.skipped = 0 AND w.watched_at >= ? AND w.watched_at < ?`,
  ).bind(from, to).all<{ item_id: number; season: number | null; watched_at: string; run: number; type: string; title: string; minutes: number | null; genres_json: string | null }>();
  const rows = results ?? [];
  const months = Array.from({ length: 12 }, (_, index) => ({ month: index + 1, films: 0, episodes: 0, minutes: 0 }));
  const genres = new Map<string, number>();
  const shows = new Map<number, { item_id: number; title: string; episodes: number }>();
  let films = 0, episodes = 0, minutes = 0, rewatches = 0;
  const titles = new Set<number>();
  for (const row of rows) {
    const film = row.season == null;
    const length = row.minutes ?? (film ? FALLBACK_MINUTES.film : FALLBACK_MINUTES.episode);
    const month = months[Number(row.watched_at.slice(5, 7)) - 1];
    if (film) { films++; if (month) month.films++; } else { episodes++; if (month) month.episodes++; }
    if (row.run > 0) rewatches++;
    minutes += length;
    if (month) month.minutes += length;
    titles.add(row.item_id);
    if (!film) {
      const show = shows.get(row.item_id) ?? { item_id: row.item_id, title: row.title, episodes: 0 };
      show.episodes++;
      shows.set(row.item_id, show);
    }
  }
  // Genres count titles, not episodes, so one long show doesn't drown out the films.
  const seenTitles = new Set<number>();
  for (const row of rows) {
    if (seenTitles.has(row.item_id)) continue;
    seenTitles.add(row.item_id);
    for (const genre of json<string[]>(row.genres_json, [])) genres.set(genre, (genres.get(genre) ?? 0) + 1);
  }
  return {
    year: year ?? null,
    films,
    episodes,
    titles: titles.size,
    minutes,
    rewatches,
    months: year ? months : [],
    genres: [...genres.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    shows: [...shows.values()].sort((a, b) => b.episodes - a.episodes).slice(0, 10),
  };
}

export const PICK_OUTCOMES = ["picked", "not_tonight", "started"] as const;

export async function recordPick(env: Env, itemId: number, outcome: (typeof PICK_OUTCOMES)[number]) {
  await itemRow(env, itemId);
  const at = now();
  const row = await env.DB.prepare("INSERT INTO media_picks (item_id, outcome, picked_at) VALUES (?, ?, ?) RETURNING id")
    .bind(itemId, outcome, at).first<{ id: number }>();
  return { id: row?.id ?? null, item_id: itemId, outcome, picked_at: at };
}

/** Recent picks, so the picker can leave out what it offered lately. */
export async function recentPicks(env: Env, limit = 30) {
  const { results } = await env.DB.prepare("SELECT id, item_id, outcome, picked_at FROM media_picks ORDER BY picked_at DESC, id DESC LIMIT ?")
    .bind(limit).all<{ id: number; item_id: number; outcome: string; picked_at: string }>();
  return results ?? [];
}

/** Which TMDB titles are already on the shelf, for search results. */
export async function shelfIdsFor(env: Env, type: TmdbMediaType, tmdbIds: number[]): Promise<Map<number, number>> {
  if (!tmdbIds.length) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT item_id, tmdb_id FROM media_links WHERE media_type = ? AND tmdb_id IN (${tmdbIds.map(() => "?").join(", ")})`,
  ).bind(type, ...tmdbIds).all<{ item_id: number; tmdb_id: number }>();
  return new Map((results ?? []).map((row) => [row.tmdb_id, row.item_id]));
}
