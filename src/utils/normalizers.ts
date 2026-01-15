import type { JsonRecord } from "../types/common";
import { parseStoredJson } from "./json";

export function normalizeProfile(row: JsonRecord): JsonRecord {
  const { handles_json, contact_json, ...rest } = row;
  return {
    ...rest,
    handles: parseStoredJson(handles_json),
    contact: parseStoredJson(contact_json),
  };
}

export function normalizeSettings(row: JsonRecord): JsonRecord {
  const { public_fields_json, flags_json, shelf_config_json, ...rest } = row;
  return {
    ...rest,
    public_fields: parseStoredJson(public_fields_json),
    flags: parseStoredJson(flags_json),
    shelf_config: parseStoredJson(shelf_config_json),
  };
}

export function normalizeProject(row: JsonRecord): JsonRecord {
  const { links_json, tags_json, ...rest } = row;
  return {
    ...rest,
    links: parseStoredJson(links_json),
    tags: parseStoredJson(tags_json),
  };
}

export function normalizeNote(row: JsonRecord): JsonRecord {
  const { tags_json, ...rest } = row;
  return {
    ...rest,
    tags: parseStoredJson(tags_json),
  };
}

export function normalizeEvent(row: JsonRecord): JsonRecord {
  const { payload_json, ...rest } = row;
  return {
    ...rest,
    payload: parseStoredJson(payload_json),
  };
}

export function normalizePost(row: JsonRecord): JsonRecord {
  const { tags_json, pinned, ...rest } = row;
  return {
    ...rest,
    tags: parseStoredJson(tags_json),
    pinned: Boolean(pinned),
  };
}

export function normalizeShelfItem(row: JsonRecord): JsonRecord {
  const { tags_json, ...rest } = row;
  return {
    ...rest,
    tags: parseStoredJson(tags_json),
  };
}

export function normalizeSkill(row: JsonRecord): JsonRecord {
  const { items_json, ...rest } = row;
  return {
    ...rest,
    items: parseStoredJson(items_json),
  };
}

export function normalizePhoto(row: JsonRecord): JsonRecord {
  const { tags_json, ...rest } = row;
  return {
    ...rest,
    tags: parseStoredJson(tags_json),
  };
}

export function normalizeStatusSnapshot(row: JsonRecord): JsonRecord {
  const { activity_json, spotify_json, payload_json, ...rest } = row;
  return {
    ...rest,
    activity: parseStoredJson(activity_json),
    spotify: parseStoredJson(spotify_json),
    payload: parseStoredJson(payload_json),
  };
}

export function normalizeWakaTimeHourly(row: JsonRecord): JsonRecord {
  const { languages_json, ...rest } = row;
  return {
    ...rest,
    languages: parseStoredJson(languages_json) ?? {},
  };
}

export function normalizeCustomExercise(row: JsonRecord): JsonRecord {
  const { muscles_json, equipment_json, ...rest } = row;
  return {
    ...rest,
    muscles: parseStoredJson(muscles_json),
    equipment: parseStoredJson(equipment_json),
  };
}

export function normalizeCustomWorkoutTemplate(row: JsonRecord): JsonRecord {
  const { exercises_json, ...rest } = row;
  return {
    ...rest,
    exercises: parseStoredJson(exercises_json),
  };
}

export function normalizeCustomWorkoutSchedule(row: JsonRecord): JsonRecord {
  const { days_of_week_json, exceptions_json, ...rest } = row;
  return {
    ...rest,
    days_of_week: parseStoredJson(days_of_week_json),
    exceptions: parseStoredJson(exceptions_json),
  };
}

export function normalizeCustomWorkoutSet(row: JsonRecord): JsonRecord {
  const { done, ...rest } = row;
  return {
    ...rest,
    done: done == null ? null : Boolean(done),
  };
}

export function normalizeLogDay(row: JsonRecord): JsonRecord {
  const { entries_json, tags_json, ...rest } = row;
  return {
    ...rest,
    entries: parseStoredJson(entries_json),
    tags: parseStoredJson(tags_json),
  };
}
