import type { Env } from "../types/env";

const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
const POSTER_SIZE = "w500";

export type TmdbMediaType = "movie" | "tv";

export type TmdbCandidate = {
  tmdb_id: number;
  tmdb_media_type: TmdbMediaType;
  title: string;
  original_title?: string;
  year?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string;
  poster_url?: string;
  backdrop_path?: string;
  backdrop_url?: string;
  popularity?: number;
  vote_count?: number;
  score: number;
};

type TmdbSearchResult = {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  popularity?: number;
  vote_count?: number;
};

export function normalizeTmdbMediaType(value: string | undefined | null): TmdbMediaType | null {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "movie" || normalized === "movies" || normalized === "film") {
    return "movie";
  }
  if (normalized === "tv" || normalized === "show" || normalized === "shows" || normalized === "series") {
    return "tv";
  }
  return null;
}

export function tmdbPosterUrl(path: string | null | undefined, size = POSTER_SIZE): string | undefined {
  if (!path) return undefined;
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

export async function searchTmdbMedia(
  env: Env,
  input: { type: TmdbMediaType; query: string; year?: string | null; limit?: number }
): Promise<TmdbCandidate[]> {
  const query = input.query.trim();
  if (!query) return [];

  const url = new URL(`${TMDB_API_BASE_URL}/search/${input.type}`);
  url.searchParams.set("query", cleanTitle(query));
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("language", "en-US");
  url.searchParams.set("page", "1");
  if (input.year) {
    url.searchParams.set(input.type === "tv" ? "first_air_date_year" : "year", input.year);
  }
  applyApiKey(url, env);

  const body = await tmdbFetch<{ results?: TmdbSearchResult[] }>(url, env);
  const results = Array.isArray(body.results) ? body.results : [];
  return results
    .map((result) => toCandidate(result, input.type, query, input.year ?? undefined))
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit ?? 8);
}

export async function getTmdbMedia(
  env: Env,
  input: { type: TmdbMediaType; tmdbId: number }
): Promise<TmdbCandidate | null> {
  const url = new URL(`${TMDB_API_BASE_URL}/${input.type}/${input.tmdbId}`);
  url.searchParams.set("language", "en-US");
  applyApiKey(url, env);

  const result = await tmdbFetch<TmdbSearchResult>(url, env);
  if (!result?.id) return null;
  return toCandidate(result, input.type, result.title ?? result.name ?? "", undefined);
}

export type TmdbTvSeason = {
  season_number: number;
  episode_count: number;
  name?: string;
  air_date?: string;
};

export type TmdbTvDetails = {
  tmdb_id: number;
  title: string;
  status?: string;
  number_of_seasons: number;
  number_of_episodes: number;
  /** Regular seasons in order; specials (season 0) are left out. */
  seasons: TmdbTvSeason[];
  next_episode_to_air?: { season_number: number; episode_number: number; air_date?: string };
  poster_url?: string;
};

/** A show's seasons and episode counts, so the apps can say "S2 E5" and what's next. */
export async function getTmdbTvDetails(env: Env, tmdbId: number): Promise<TmdbTvDetails | null> {
  const url = new URL(`${TMDB_API_BASE_URL}/tv/${tmdbId}`);
  url.searchParams.set("language", "en-US");
  applyApiKey(url, env);

  type Raw = {
    id?: number;
    name?: string;
    status?: string;
    number_of_seasons?: number;
    number_of_episodes?: number;
    poster_path?: string | null;
    seasons?: { season_number?: number; episode_count?: number; name?: string; air_date?: string | null }[];
    next_episode_to_air?: { season_number?: number; episode_number?: number; air_date?: string | null } | null;
  };
  const raw = await tmdbFetch<Raw>(url, env);
  if (!raw?.id) return null;
  const seasons = (Array.isArray(raw.seasons) ? raw.seasons : [])
    .filter((season) => Number(season.season_number) > 0 && Number(season.episode_count) > 0)
    .map((season) => ({
      season_number: Number(season.season_number),
      episode_count: Number(season.episode_count),
      ...(season.name ? { name: season.name } : {}),
      ...(season.air_date ? { air_date: season.air_date } : {}),
    }))
    .sort((left, right) => left.season_number - right.season_number);
  const next = raw.next_episode_to_air;
  return {
    tmdb_id: raw.id,
    title: raw.name ?? "",
    ...(raw.status ? { status: raw.status } : {}),
    number_of_seasons: Number(raw.number_of_seasons) || seasons.length,
    number_of_episodes: Number(raw.number_of_episodes) || seasons.reduce((sum, season) => sum + season.episode_count, 0),
    seasons,
    ...(next && next.season_number && next.episode_number
      ? {
          next_episode_to_air: {
            season_number: next.season_number,
            episode_number: next.episode_number,
            ...(next.air_date ? { air_date: next.air_date } : {}),
          },
        }
      : {}),
    ...(raw.poster_path ? { poster_url: tmdbPosterUrl(raw.poster_path) } : {}),
  };
}

async function tmdbFetch<T>(url: URL, env: Env): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (env.TMDB_ACCESS_TOKEN) {
    headers.set("Authorization", `Bearer ${env.TMDB_ACCESS_TOKEN}`);
  }

  if (!env.TMDB_ACCESS_TOKEN && !env.TMDB_API_KEY) {
    throw new Error("TMDB credentials are not configured");
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("[tmdb] request failed", {
      status: response.status,
      statusText: response.statusText,
      body,
    });
    throw new Error("TMDB request failed");
  }
  return response.json() as Promise<T>;
}

function applyApiKey(url: URL, env: Env): void {
  if (!env.TMDB_ACCESS_TOKEN && env.TMDB_API_KEY) {
    url.searchParams.set("api_key", env.TMDB_API_KEY);
  }
}

function toCandidate(
  result: TmdbSearchResult,
  mediaType: TmdbMediaType,
  query: string,
  year?: string
): TmdbCandidate {
  const title = result.title ?? result.name ?? "Untitled";
  const originalTitle = result.original_title ?? result.original_name ?? undefined;
  const releaseDate = result.release_date ?? result.first_air_date ?? undefined;
  const resultYear = dateYear(releaseDate);
  const titleKey = normalizeTitle(title);
  const queryKey = normalizeTitle(query);
  let score = 0;

  if (titleKey === queryKey) score += 50;
  else if (titleKey.includes(queryKey) || queryKey.includes(titleKey)) score += 20;
  if (year && resultYear === year) score += 25;
  score += Math.min(Number(result.popularity) || 0, 50) / 5;
  score += Math.min(Number(result.vote_count) || 0, 1000) / 200;
  if (result.poster_path) score += 8;

  return {
    tmdb_id: result.id,
    tmdb_media_type: mediaType,
    title,
    original_title: originalTitle,
    year: resultYear ?? undefined,
    release_date: releaseDate,
    overview: result.overview,
    poster_path: result.poster_path ?? undefined,
    poster_url: tmdbPosterUrl(result.poster_path),
    backdrop_path: result.backdrop_path ?? undefined,
    backdrop_url: tmdbPosterUrl(result.backdrop_path, "w780"),
    popularity: result.popularity,
    vote_count: result.vote_count,
    score: Number(score.toFixed(2)),
  };
}

function cleanTitle(value: string): string {
  return value
    .replace(/\s+\(\d{4}\)$/u, "")
    .replace(/\s+\(\d{4}[-\u2013]\d{4}\)$/u, "")
    .trim();
}

function normalizeTitle(value: string): string {
  return cleanTitle(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dateYear(value: string | undefined): string | null {
  const match = /^(\d{4})/.exec(value ?? "");
  return match ? match[1] : null;
}
