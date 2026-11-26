// How each WHOOP resource is stored: its table, key and columns, and the
// mapping from a provider record to that row (pure). Used by repository.ts.

import type { WhoopResource } from "../../types/whoop";
import type { SourceDefinition, SourceRecordMap, WebhookTombstoneLookup } from "./repository-types";

const objectAt = (value: unknown, key: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return {};
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "object" && nested !== null ? nested as Record<string, unknown> : {};
};

const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export const canonicalTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) throw new Error("Invalid WHOOP timestamp");
  return new Date(milliseconds).toISOString();
};

const firstNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    const number = nullableNumber(value);
    if (number !== null) return number;
  }
  return null;
};

const rawJson = (record: Record<string, unknown>): string => {
  if (typeof record.rawJson === "string") return record.rawJson;
  const { rawJson: _rawJson, ...providerRecord } = record;
  return JSON.stringify(providerRecord);
};

const scoreOf = (record: Record<string, unknown>): Record<string, unknown> => objectAt(record, "score");

export const webhookTombstoneLookup = (
  resource: WhoopResource,
  record: SourceRecordMap[WhoopResource],
): WebhookTombstoneLookup | null => {
  if (resource !== "recovery" && resource !== "sleep" && resource !== "workout") return null;
  const source = record as unknown as Record<string, unknown>;
  const providerId = resource === "recovery" ? source.sleep_id : source.id;
  if (typeof source.user_id !== "number" || (typeof providerId !== "string" && typeof providerId !== "number")) {
    throw new Error("WHOOP webhook source identity is not available");
  }
  return {
    whoopUserId: source.user_id,
    providerId,
    eventType: `${resource}.deleted`,
  };
};

export const sourceDefinitions: Record<WhoopResource, SourceDefinition> = {
  profile: {
    table: "whoop_profiles",
    keyColumn: "whoop_user_id",
    columns: [
      "whoop_user_id", "first_name", "last_name", "email", "upstream_created_at",
      "upstream_updated_at", "deleted_at", "synced_at", "raw_json",
    ],
    values: (record, syncedAt) => {
      const profile = record as unknown as Record<string, unknown>;
      return [
        profile.user_id, nullableString(profile.first_name), nullableString(profile.last_name),
        nullableString(profile.email), canonicalTimestamp(profile.created_at), canonicalTimestamp(profile.updated_at),
        null, syncedAt, rawJson(profile),
      ];
    },
  },
  body_measurement: {
    table: "whoop_body_measurements",
    keyColumn: "whoop_user_id",
    columns: [
      "whoop_user_id", "height_meter", "weight_kilogram", "max_heart_rate",
      "upstream_created_at", "upstream_updated_at", "deleted_at", "synced_at", "raw_json",
    ],
    values: (record, syncedAt) => {
      const body = record as unknown as Record<string, unknown>;
      const whoopUserId = body.whoop_user_id ?? body.user_id;
      if (typeof whoopUserId !== "number") {
        throw new Error("WHOOP body measurement requires connection user context");
      }
      return [
        whoopUserId, nullableNumber(body.height_meter), nullableNumber(body.weight_kilogram),
        nullableNumber(body.max_heart_rate), canonicalTimestamp(body.created_at), canonicalTimestamp(body.updated_at),
        null, syncedAt, rawJson(body),
      ];
    },
  },
  cycle: {
    table: "whoop_cycles",
    keyColumn: "cycle_id",
    columns: [
      "cycle_id", "whoop_user_id", "start_at", "end_at", "timezone_offset", "score_state",
      "strain", "kilojoules", "average_heart_rate", "max_heart_rate", "upstream_created_at",
      "upstream_updated_at", "deleted_at", "synced_at", "raw_json",
    ],
    values: (record, syncedAt) => {
      const cycle = record as unknown as Record<string, unknown>;
      const score = scoreOf(cycle);
      return [
        cycle.id, cycle.user_id, cycle.start, cycle.end ?? null, cycle.timezone_offset, cycle.score_state,
        nullableNumber(score.strain), nullableNumber(score.kilojoule), nullableNumber(score.average_heart_rate),
        nullableNumber(score.max_heart_rate), canonicalTimestamp(cycle.created_at), canonicalTimestamp(cycle.updated_at),
        null, syncedAt, rawJson(cycle),
      ];
    },
  },
  recovery: {
    table: "whoop_recoveries",
    keyColumn: "sleep_id",
    columns: [
      "sleep_id", "cycle_id", "whoop_user_id", "score_state", "user_calibrating", "recovery_score",
      "resting_heart_rate", "hrv_rmssd_milliseconds", "spo2_percentage", "skin_temperature_celsius",
      "upstream_created_at", "upstream_updated_at", "deleted_at", "synced_at", "raw_json",
    ],
    values: (record, syncedAt) => {
      const recovery = record as unknown as Record<string, unknown>;
      const score = scoreOf(recovery);
      return [
        recovery.sleep_id, recovery.cycle_id, recovery.user_id, recovery.score_state,
        typeof score.user_calibrating === "boolean" ? Number(score.user_calibrating) : null,
        nullableNumber(score.recovery_score), nullableNumber(score.resting_heart_rate),
        firstNumber(score.hrv_rmssd_milli, score.hrv_rmssd_milliseconds), nullableNumber(score.spo2_percentage),
        firstNumber(score.skin_temp_celsius, score.skin_temperature_celsius), canonicalTimestamp(recovery.created_at),
        canonicalTimestamp(recovery.updated_at), null, syncedAt, rawJson(recovery),
      ];
    },
  },
  sleep: {
    table: "whoop_sleeps",
    keyColumn: "sleep_id",
    columns: [
      "sleep_id", "cycle_id", "whoop_user_id", "start_at", "end_at", "timezone_offset", "nap",
      "score_state", "stage_awake_milliseconds", "stage_light_milliseconds", "stage_slow_wave_milliseconds",
      "stage_rem_milliseconds", "stage_in_bed_milliseconds", "stage_no_data_milliseconds",
      "sleep_needed_milliseconds", "sleep_debt_milliseconds", "sleep_need_recent_strain_milliseconds",
      "sleep_need_recent_nap_milliseconds", "sleep_cycle_count", "disturbance_count",
      "sleep_efficiency_percentage", "sleep_consistency_percentage", "sleep_performance_percentage",
      "respiratory_rate", "upstream_created_at", "upstream_updated_at", "deleted_at", "synced_at", "raw_json",
    ],
    values: (record, syncedAt) => {
      const sleep = record as unknown as Record<string, unknown>;
      const score = scoreOf(sleep);
      const stages = objectAt(score, "stage_summary");
      const needed = objectAt(score, "sleep_needed");
      return [
        sleep.id, sleep.cycle_id, sleep.user_id, sleep.start ?? null, sleep.end ?? null, sleep.timezone_offset,
        typeof sleep.nap === "boolean" ? Number(sleep.nap) : null, sleep.score_state,
        firstNumber(stages.total_awake_time_milli, stages.awake_milli),
        firstNumber(stages.total_light_sleep_time_milli, stages.light_milli),
        firstNumber(stages.total_slow_wave_sleep_time_milli, stages.slow_wave_milli),
        firstNumber(stages.total_rem_sleep_time_milli, stages.rem_milli),
        nullableNumber(stages.total_in_bed_time_milli),
        nullableNumber(stages.total_no_data_time_milli),
        firstNumber(needed.baseline_milli, needed.sleep_needed_milli),
        firstNumber(needed.need_from_sleep_debt_milli, needed.sleep_debt_milli),
        nullableNumber(needed.need_from_recent_strain_milli),
        nullableNumber(needed.need_from_recent_nap_milli),
        nullableNumber(stages.sleep_cycle_count), nullableNumber(stages.disturbance_count),
        nullableNumber(score.sleep_efficiency_percentage), nullableNumber(score.sleep_consistency_percentage),
        nullableNumber(score.sleep_performance_percentage), nullableNumber(score.respiratory_rate),
        canonicalTimestamp(sleep.created_at), canonicalTimestamp(sleep.updated_at), null, syncedAt, rawJson(sleep),
      ];
    },
  },
  workout: {
    table: "whoop_workouts",
    keyColumn: "workout_id",
    columns: [
      "workout_id", "whoop_user_id", "start_at", "end_at", "timezone_offset", "sport_id", "sport_name",
      "score_state", "strain", "average_heart_rate", "max_heart_rate", "kilojoules", "percent_recorded",
      "distance_meter", "elevation_gain_meter", "zone_zero_milliseconds", "zone_one_milliseconds",
      "zone_two_milliseconds", "zone_three_milliseconds", "zone_four_milliseconds", "zone_five_milliseconds",
      "upstream_created_at", "upstream_updated_at", "deleted_at", "synced_at", "raw_json",
    ],
    values: (record, syncedAt) => {
      const workout = record as unknown as Record<string, unknown>;
      const score = scoreOf(workout);
      // WHOOP v2 uses the plural name; retain the older payload alias.
      const zones = objectAt(score, "zone_durations" in score ? "zone_durations" : "zone_duration");
      return [
        workout.id, workout.user_id, workout.start ?? null, workout.end ?? null, workout.timezone_offset,
        nullableNumber(workout.sport_id), workout.sport_name, workout.score_state, nullableNumber(score.strain),
        nullableNumber(score.average_heart_rate), nullableNumber(score.max_heart_rate), nullableNumber(score.kilojoule),
        nullableNumber(score.percent_recorded), nullableNumber(score.distance_meter), nullableNumber(score.altitude_gain_meter),
        firstNumber(zones.zone_zero_milli, zones.zone_zero_milliseconds),
        firstNumber(zones.zone_one_milli, zones.zone_one_milliseconds),
        firstNumber(zones.zone_two_milli, zones.zone_two_milliseconds),
        firstNumber(zones.zone_three_milli, zones.zone_three_milliseconds),
        firstNumber(zones.zone_four_milli, zones.zone_four_milliseconds),
        firstNumber(zones.zone_five_milli, zones.zone_five_milliseconds),
        canonicalTimestamp(workout.created_at), canonicalTimestamp(workout.updated_at),
        null, syncedAt, rawJson(workout),
      ];
    },
  },
};

export const reconciliationDefinitions = {
  cycle: { table: "whoop_cycles", keyColumn: "cycle_id", windowColumn: "start_at", syncedColumn: "synced_at" },
  recovery: {
    table: "whoop_recoveries", keyColumn: "sleep_id", syncedColumn: "synced_at",
    // WHOOP windows recoveries by the related sleep, not when scoring completed.
    // Without that sleep we cannot prove an omission is a deletion.
    windowColumn: `(SELECT sleep.start_at FROM whoop_sleeps AS sleep
      WHERE sleep.sleep_id = whoop_recoveries.sleep_id
        AND sleep.whoop_user_id = whoop_recoveries.whoop_user_id)`,
  },
  sleep: { table: "whoop_sleeps", keyColumn: "sleep_id", windowColumn: "start_at", syncedColumn: "synced_at" },
  workout: { table: "whoop_workouts", keyColumn: "workout_id", windowColumn: "start_at", syncedColumn: "synced_at" },
} as const;
