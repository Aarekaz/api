import type { JsonRecord } from "../types/common";
import type { TmdbCandidate } from "./tmdb";
import { getTag } from "../utils/tags";

// Helpers for enriching shelf items from TMDB and reading their stored JSON (pure).

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compactRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  );
}

export function normalizeTmdbMetadata(candidate: TmdbCandidate): JsonRecord {
  return compactRecord({
    id: candidate.tmdb_id,
    media_type: candidate.tmdb_media_type,
    title: candidate.title,
    original_title: candidate.original_title,
    year: candidate.year,
    release_date: candidate.release_date,
    overview: candidate.overview,
    poster_path: candidate.poster_path,
    poster_url: candidate.poster_url,
    backdrop_path: candidate.backdrop_path,
    backdrop_url: candidate.backdrop_url,
  });
}

export function shouldReplaceShelfImage(item: JsonRecord, tags: unknown): boolean {
  if (!item.image_url) return true;
  return getTag(tags, "poster_source") === "tmdb";
}

export function parseStoredRecord(value: unknown): JsonRecord {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return isJsonRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
