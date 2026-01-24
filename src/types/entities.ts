import { z } from "zod";
import {
  appleHealthDailySchema,
  appleHealthHeartRateSchema,
  appleHealthSleepSessionSchema,
  appleHealthWorkoutSchema,
} from "../schemas/health";

// =============================================================================
// INFERRED TYPES FROM ZOD SCHEMAS
// These are the input types (what the API accepts)
// =============================================================================

export type AppleHealthDailyInput = z.infer<typeof appleHealthDailySchema>;
export type AppleHealthHeartRateInput = z.infer<typeof appleHealthHeartRateSchema>;
export type AppleHealthSleepSessionInput = z.infer<typeof appleHealthSleepSessionSchema>;
export type AppleHealthWorkoutInput = z.infer<typeof appleHealthWorkoutSchema>;

// =============================================================================
// DATABASE ENTITY TYPES
// These represent what's stored in D1 (includes id, created_at, updated_at)
// =============================================================================

/** Base fields present on most database entities */
interface BaseEntity {
  id: number;
  created_at: string;
  updated_at?: string | null;
}

/** Apple Health daily metrics stored in D1 */
export interface HealthDailyEntity extends AppleHealthDailyInput {
  id?: number; // Not always present (e.g., upsert by date)
  created_at?: string;
  updated_at?: string | null;
}

/** Heart rate sample entity */
export interface HeartRateEntity extends AppleHealthHeartRateInput, BaseEntity {}

/** Sleep session entity */
export interface SleepSessionEntity extends AppleHealthSleepSessionInput, BaseEntity {}

/** Workout entity */
export interface WorkoutEntity extends AppleHealthWorkoutInput, BaseEntity {}

/** Profile entity */
export interface ProfileEntity {
  name: string;
  bio?: string | null;
  avatar?: string | null;
  handles?: Record<string, string>;
  contact?: Record<string, string>;
  created_at?: string;
  updated_at?: string | null;
}

/** Project entity */
export interface ProjectEntity extends BaseEntity {
  title: string;
  description?: string | null;
  url?: string | null;
  repo?: string | null;
  image?: string | null;
  status?: string | null;
  featured?: boolean;
  sort_order?: number | null;
  links?: Array<{ label: string; url: string }>;
  tags?: string[];
}

/** Note entity */
export interface NoteEntity extends BaseEntity {
  title: string;
  content?: string | null;
  tags?: string[];
}

/** Event entity */
export interface EventEntity extends BaseEntity {
  title: string;
  type: string;
  date?: string | null;
  end_date?: string | null;
  location?: string | null;
  description?: string | null;
  payload?: Record<string, unknown>;
}

/** Post entity */
export interface PostEntity extends BaseEntity {
  title: string;
  slug: string;
  content?: string | null;
  excerpt?: string | null;
  published_at?: string | null;
  pinned?: boolean;
  tags?: string[];
}

/** WakaTime daily summary */
export interface WakaTimeDailyEntity {
  date: string;
  total_seconds: number;
  languages?: Record<string, number>;
  editors?: Record<string, number>;
  projects?: Record<string, number>;
  created_at?: string;
}

/** GitHub contribution entity */
export interface GitHubContributionEntity {
  date: string;
  contributions: number;
  created_at?: string;
}

/** Location entity */
export interface LocationEntity extends BaseEntity {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  altitude?: number | null;
  speed?: number | null;
  heading?: number | null;
  source?: string | null;
  recorded_at: string;
}

/** Custom exercise entity */
export interface CustomExerciseEntity extends BaseEntity {
  name: string;
  category?: string | null;
  muscles?: string[];
  equipment?: string[];
  description?: string | null;
}

/** Custom workout template entity */
export interface WorkoutTemplateEntity extends BaseEntity {
  name: string;
  description?: string | null;
  exercises?: Array<{
    exercise_id: number;
    sets?: number;
    reps?: number;
    weight?: number;
    duration_seconds?: number;
    notes?: string;
  }>;
}

/** Custom workout session entity */
export interface WorkoutSessionEntity extends BaseEntity {
  template_id?: number | null;
  session_date: string;
  started_at?: string | null;
  completed_at?: string | null;
  notes?: string | null;
}

/** Custom workout set entity */
export interface WorkoutSetEntity extends BaseEntity {
  session_id: number;
  exercise_id: number;
  set_number: number;
  reps?: number | null;
  weight?: number | null;
  duration_seconds?: number | null;
  done?: boolean;
  notes?: string | null;
}

/** Log day entity */
export interface LogDayEntity {
  date: string;
  entries?: Array<{
    time?: string;
    content: string;
    mood?: string;
  }>;
  tags?: string[];
  created_at?: string;
  updated_at?: string | null;
}

// =============================================================================
// D1 RESULT TYPES
// Type helpers for D1 query results
// =============================================================================

/** Raw D1 row before normalization (JSON fields stored as _json strings) */
export type RawD1Row = Record<string, unknown>;

/** D1 query result wrapper */
export interface D1QueryResult<T> {
  results: T[];
  success: boolean;
  meta: {
    changes: number;
    duration: number;
    last_row_id: number;
  };
}
