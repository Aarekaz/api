import type {
  WhoopBodyMeasurement,
  WhoopCycle,
  WhoopProfile,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
} from "../../schemas/whoop";
import type {
  WhoopConnectionStatus,
  WhoopResource,
  WhoopWebhookEventType,
} from "../../types/whoop";
import {
  WhoopRefreshAmbiguousError,
  WhoopUnauthorizedError,
  type WhoopTokenResponse,
} from "./client";
import {
  decryptWhoopToken,
  encryptWhoopToken,
  type EncryptedToken,
} from "./crypto";

const REFRESH_LEASE_MILLISECONDS = 30_000;
const REFRESH_ABORT_MILLISECONDS = 20_000;
const REFRESH_WAIT_MILLISECONDS = 100;
export const WHOOP_OPERATIONAL_RETENTION = {
  oauthStateMilliseconds: 24 * 60 * 60 * 1_000,
  reconcileSeenMilliseconds: 24 * 60 * 60 * 1_000,
  checkpointMilliseconds: 30 * 24 * 60 * 60 * 1_000,
  syncRunMilliseconds: 30 * 24 * 60 * 60 * 1_000,
  processedWebhookMilliseconds: 30 * 24 * 60 * 60 * 1_000,
  deleteLimit: 100,
} as const;

export type TombstonePolicy = "preserve" | "reconcile";

type PersistableProviderRecord<T> = T & { rawJson?: string };
type ProfileRecord = PersistableProviderRecord<WhoopProfile>;
type BodyMeasurementRecord = PersistableProviderRecord<WhoopBodyMeasurement> & {
  whoop_user_id?: number;
  user_id?: number;
};

interface SourceRecordMap {
  profile: ProfileRecord;
  body_measurement: BodyMeasurementRecord;
  cycle: PersistableProviderRecord<WhoopCycle>;
  recovery: PersistableProviderRecord<WhoopRecovery>;
  sleep: PersistableProviderRecord<WhoopSleep>;
  workout: PersistableProviderRecord<WhoopWorkout>;
}

export interface UpsertConnectionInput {
  whoopUserId: number;
  connectionId: string;
  status: Exclude<WhoopConnectionStatus, "not_connected">;
  accessToken: EncryptedToken;
  accessTokenExpiresAt: string;
  refreshToken: EncryptedToken;
  grantedScopes: readonly string[];
  connectedAt: string;
  updatedAt?: string;
  initialBackfillPending?: boolean;
}

export interface RotatedTokenInput {
  accessToken: EncryptedToken;
  accessTokenExpiresAt: string;
  refreshToken: EncryptedToken;
  grantedScopes: readonly string[];
  refreshedAt: string;
}

export interface SyncRunInput {
  runId: string;
  whoopUserId: number;
  connectionId: string;
  reconcileGeneration: number;
  trigger: string;
  expectedTargetCount: number;
  startedAt: string;
}

export interface SyncRunProjection {
  run_id: string;
  trigger: string;
  status: "queued" | "running" | "retrying" | "complete" | "error";
  page_count: number;
  record_count: number;
  expected_target_count: number;
  completed_target_count: number;
  started_at: string;
  succeeded_at: string | null;
  failed_at: string | null;
  last_error: string | null;
}

export interface CheckpointInput {
  whoopUserId: number;
  connectionId: string;
  reconcileGeneration: number;
  resource: WhoopResource;
  mode: string;
  syncRunId: string;
  targetId: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  nextToken?: string | null;
  status: string;
  pageCount: number;
  recordCount: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
}

export interface WebhookEventInput {
  traceId: string;
  whoopUserId: number;
  connectionId: string;
  resourceId: string;
  eventType: WhoopWebhookEventType;
  receivedAt: string;
}

export type WebhookEventStatus = "received" | "queued" | "processed" | "retrying" | "error";

export interface ConnectionStatusProjection {
  status: WhoopConnectionStatus;
  granted_scopes?: string[];
  connected_at?: string | null;
  refreshed_at?: string | null;
  last_success_at?: string | null;
  last_error_at?: string | null;
  disconnected_at?: string | null;
  last_error?: string | null;
  consecutive_failure_count?: number;
  updated_at?: string;
}

export interface SyncProgressProjection {
  resource: WhoopResource;
  mode: string;
  status: string;
  page_count: number;
  record_count: number;
  updated_at: string;
  last_error: string | null;
}

export interface CurrentWhoopConnection extends ConnectionStatusProjection {
  whoopUserId: number;
  connectionId: string;
  credentialVersion: number;
  reconcileGeneration: number;
}

export interface PendingInitialBackfill {
  whoopUserId: number;
  connectionId: string;
  credentialVersion: number;
}

interface TokenConnectionRow {
  whoop_user_id: number;
  connection_id: string;
  status: Exclude<WhoopConnectionStatus, "not_connected">;
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_expires_at: string | null;
  refresh_token_ciphertext: string | null;
  refresh_token_nonce: string | null;
  granted_scopes: string;
  credential_version: number;
}

interface AccessTokenOptions {
  now?: () => Date;
  leaseId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  expectedConnectionId?: string;
  refreshBeforeExpirationMilliseconds?: number;
}

type AccessTokenRequest<T> = (accessToken: string, credentialVersion: number) => Promise<T>;
type RefreshTokenRequest = (
  refreshToken: string,
  options: { signal: AbortSignal },
) => Promise<WhoopTokenResponse>;

interface SourceDefinition {
  table: string;
  keyColumn: string;
  columns: readonly string[];
  values: (record: SourceRecordMap[WhoopResource], syncedAt: string) => unknown[];
}

interface WebhookTombstoneLookup {
  whoopUserId: number;
  providerId: string | number;
  eventType: WhoopWebhookEventType;
}

interface ReconciliationSeenInput {
  whoopUserId: number;
  connectionId: string;
  reconcileGeneration: number;
  reconcileRunId: string;
  resource: "cycle" | "recovery" | "sleep" | "workout";
  providerId: string | number;
  seenAt: string;
}

const objectAt = (value: unknown, key: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return {};
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "object" && nested !== null ? nested as Record<string, unknown> : {};
};

const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const canonicalTimestamp = (value: unknown): string | null => {
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

const webhookTombstoneLookup = (
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

const sourceDefinitions: Record<WhoopResource, SourceDefinition> = {
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
      const zones = objectAt(score, "zone_duration");
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

const reconciliationDefinitions = {
  cycle: { table: "whoop_cycles", keyColumn: "cycle_id", windowColumn: "start_at", syncedColumn: "synced_at" },
  recovery: { table: "whoop_recoveries", keyColumn: "sleep_id", windowColumn: "upstream_created_at", syncedColumn: "synced_at" },
  sleep: { table: "whoop_sleeps", keyColumn: "sleep_id", windowColumn: "start_at", syncedColumn: "synced_at" },
  workout: { table: "whoop_workouts", keyColumn: "workout_id", windowColumn: "start_at", syncedColumn: "synced_at" },
} as const;

const changedRows = (result: D1Result): number => Number(result.meta.changes ?? 0);

const sanitizedError = (value: string | null | undefined): string | null => {
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const isDefiniteRefreshFailure = (error: unknown): error is Error & { refreshOutcome: "definite" } =>
  error instanceof Error
  && "refreshOutcome" in error
  && error.refreshOutcome === "definite";

const ambiguousRefreshFailure = (error: unknown): WhoopRefreshAmbiguousError =>
  error instanceof WhoopRefreshAmbiguousError
    ? error
    : new WhoopRefreshAmbiguousError("token refresh");

export class WhoopStaleConnectionError extends Error {
  constructor() {
    super("WHOOP queue connection is stale");
  }
}

export class WhoopRepository {
  constructor(
    private readonly db: D1Database,
    private readonly tokenEncryptionKey: string,
  ) {}

  async consumeOAuthState(stateHash: string, consumedAt: string): Promise<boolean> {
    const canonicalConsumedAt = canonicalTimestamp(consumedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_oauth_states
      SET consumed_at = ?
      WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
    `).bind(canonicalConsumedAt, stateHash, canonicalConsumedAt).run();
    return changedRows(result) === 1;
  }

  async createOAuthState(stateHash: string, createdAt: string, expiresAt: string): Promise<void> {
    const canonicalCreatedAt = canonicalTimestamp(createdAt)!;
    const canonicalExpiresAt = canonicalTimestamp(expiresAt)!;
    await this.db.prepare(`
      INSERT INTO whoop_oauth_states (state_hash, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, NULL)
    `).bind(stateHash, canonicalCreatedAt, canonicalExpiresAt).run();
  }

  async upsertConnection(input: UpsertConnectionInput): Promise<void> {
    const updatedAt = input.updatedAt ?? input.connectedAt;
    await this.db.prepare(`
      INSERT INTO whoop_connections (
        whoop_user_id, connection_id, status, access_token_ciphertext, access_token_nonce, access_token_expires_at,
        refresh_token_ciphertext, refresh_token_nonce, granted_scopes, credential_version, reconcile_generation, refresh_lease_id,
        refresh_lease_expires_at, refresh_dispatched_at, connected_at, refreshed_at, last_success_at, last_error_at,
        disconnected_at, last_error, consecutive_failure_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)
      ON CONFLICT(whoop_user_id) DO UPDATE SET
        connection_id = excluded.connection_id,
        status = excluded.status,
        access_token_ciphertext = excluded.access_token_ciphertext,
        access_token_nonce = excluded.access_token_nonce,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        refresh_token_nonce = excluded.refresh_token_nonce,
        granted_scopes = excluded.granted_scopes,
        credential_version = whoop_connections.credential_version + 1,
        reconcile_generation = 0,
        refresh_lease_id = NULL,
        refresh_lease_expires_at = NULL,
        refresh_dispatched_at = NULL,
        connected_at = excluded.connected_at,
        disconnected_at = NULL,
        last_error = NULL,
        consecutive_failure_count = 0,
        updated_at = excluded.updated_at
    `).bind(
      input.whoopUserId,
      input.connectionId,
      input.status,
      input.accessToken.ciphertext,
      input.accessToken.nonce,
      input.accessTokenExpiresAt,
      input.refreshToken.ciphertext,
      input.refreshToken.nonce,
      input.grantedScopes.join(" "),
      input.connectedAt,
      input.connectedAt,
      updatedAt,
    ).run();
  }

  async claimAndUpsertConnection(input: UpsertConnectionInput): Promise<number | null> {
    const updatedAt = input.updatedAt ?? input.connectedAt;
    const row = await this.db.prepare(`
      INSERT INTO whoop_connections (
        whoop_user_id, connection_id, status, access_token_ciphertext, access_token_nonce, access_token_expires_at,
        refresh_token_ciphertext, refresh_token_nonce, granted_scopes, credential_version, reconcile_generation,
        initial_backfill_pending, refresh_lease_id, refresh_lease_expires_at, refresh_dispatched_at,
        connected_at, refreshed_at, last_success_at, last_error_at, disconnected_at, last_error,
        consecutive_failure_count, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM whoop_connections
        WHERE whoop_user_id != ? AND status != 'disconnected'
      )
      ON CONFLICT(whoop_user_id) DO UPDATE SET
        connection_id = excluded.connection_id,
        status = excluded.status,
        access_token_ciphertext = excluded.access_token_ciphertext,
        access_token_nonce = excluded.access_token_nonce,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        refresh_token_nonce = excluded.refresh_token_nonce,
        granted_scopes = excluded.granted_scopes,
        credential_version = whoop_connections.credential_version + 1,
        reconcile_generation = 0,
        initial_backfill_pending = excluded.initial_backfill_pending,
        refresh_lease_id = NULL,
        refresh_lease_expires_at = NULL,
        refresh_dispatched_at = NULL,
        connected_at = excluded.connected_at,
        disconnected_at = NULL,
        last_error = NULL,
        consecutive_failure_count = 0,
        updated_at = excluded.updated_at
      RETURNING credential_version
    `).bind(
      input.whoopUserId,
      input.connectionId,
      input.status,
      input.accessToken.ciphertext,
      input.accessToken.nonce,
      input.accessTokenExpiresAt,
      input.refreshToken.ciphertext,
      input.refreshToken.nonce,
      input.grantedScopes.join(" "),
      input.initialBackfillPending ? 1 : 0,
      input.connectedAt,
      input.connectedAt,
      updatedAt,
      input.whoopUserId,
    ).first<{ credential_version: number }>();
    return row?.credential_version ?? null;
  }

  async markInitialBackfillQueued(
    whoopUserId: number,
    connectionId: string,
    credentialVersion: number,
    queuedAt: string,
  ): Promise<boolean> {
    const timestamp = canonicalTimestamp(queuedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET initial_backfill_pending = 0,
          status = CASE WHEN 6 = (
            SELECT COUNT(DISTINCT resource)
            FROM whoop_sync_checkpoints
            WHERE whoop_user_id = ? AND connection_id = ?
              AND mode = 'backfill' AND reconcile_generation = 0
              AND target_id = '' AND status = 'complete'
              AND resource IN ('profile', 'body_measurement', 'cycle', 'recovery', 'sleep', 'workout')
          ) THEN 'active' ELSE status END,
          last_success_at = CASE WHEN 6 = (
            SELECT COUNT(DISTINCT resource)
            FROM whoop_sync_checkpoints
            WHERE whoop_user_id = ? AND connection_id = ?
              AND mode = 'backfill' AND reconcile_generation = 0
              AND target_id = '' AND status = 'complete'
              AND resource IN ('profile', 'body_measurement', 'cycle', 'recovery', 'sleep', 'workout')
          ) THEN ? ELSE last_success_at END,
          updated_at = ?
      WHERE whoop_user_id = ? AND connection_id = ? AND credential_version = ?
        AND status = 'backfilling' AND initial_backfill_pending = 1
    `).bind(
      whoopUserId,
      connectionId,
      whoopUserId,
      connectionId,
      timestamp,
      timestamp,
      whoopUserId,
      connectionId,
      credentialVersion,
    ).run();
    return changedRows(result) === 1;
  }

  async getPendingInitialBackfills(): Promise<PendingInitialBackfill[]> {
    const result = await this.db.prepare(`
      SELECT whoop_user_id, connection_id, credential_version
      FROM whoop_connections
      WHERE status = 'backfilling' AND initial_backfill_pending = 1
      ORDER BY connected_at ASC, whoop_user_id ASC
    `).all<{ whoop_user_id: number; connection_id: string; credential_version: number }>();
    return result.results.map((row) => ({
      whoopUserId: row.whoop_user_id,
      connectionId: row.connection_id,
      credentialVersion: row.credential_version,
    }));
  }

  async acquireRefreshLease(
    whoopUserId: number,
    leaseId: string,
    now: string,
    credentialVersion: number,
  ): Promise<boolean> {
    const canonicalNow = canonicalTimestamp(now)!;
    const expiresAt = new Date(Date.parse(canonicalNow) + REFRESH_LEASE_MILLISECONDS).toISOString();
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET refresh_lease_id = ?, refresh_lease_expires_at = ?
      WHERE whoop_user_id = ?
        AND credential_version = ?
        AND status IN ('active', 'backfilling')
        AND refresh_dispatched_at IS NULL
        AND (refresh_lease_id IS NULL OR refresh_lease_expires_at <= ?)
    `).bind(leaseId, expiresAt, whoopUserId, credentialVersion, canonicalNow).run();
    return changedRows(result) === 1;
  }

  async releaseRefreshLease(
    whoopUserId: number,
    leaseId: string,
    credentialVersion: number,
    updatedAt = new Date().toISOString(),
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET refresh_lease_id = NULL, refresh_lease_expires_at = NULL, updated_at = ?
      WHERE whoop_user_id = ? AND refresh_lease_id = ? AND credential_version = ?
        AND refresh_dispatched_at IS NULL
    `).bind(updatedAt, whoopUserId, leaseId, credentialVersion).run();
    return changedRows(result) === 1;
  }

  private async markRefreshDispatched(
    whoopUserId: number,
    leaseId: string,
    credentialVersion: number,
    dispatchedAt: string,
  ): Promise<boolean> {
    const canonicalDispatchedAt = canonicalTimestamp(dispatchedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET refresh_dispatched_at = ?
      WHERE whoop_user_id = ? AND refresh_lease_id = ? AND credential_version = ?
        AND status IN ('active', 'backfilling')
        AND refresh_dispatched_at IS NULL
        AND refresh_lease_expires_at > ?
    `).bind(
      canonicalDispatchedAt,
      whoopUserId,
      leaseId,
      credentialVersion,
      canonicalDispatchedAt,
    ).run();
    return changedRows(result) === 1;
  }

  private async clearDefiniteRefreshFailure(
    whoopUserId: number,
    leaseId: string,
    credentialVersion: number,
    updatedAt: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET refresh_dispatched_at = NULL,
          refresh_lease_id = NULL,
          refresh_lease_expires_at = NULL,
          updated_at = ?
      WHERE whoop_user_id = ? AND refresh_lease_id = ? AND credential_version = ?
        AND refresh_dispatched_at IS NOT NULL
    `).bind(updatedAt, whoopUserId, leaseId, credentialVersion).run();
    return changedRows(result) === 1;
  }

  async storeRotatedTokens(
    whoopUserId: number,
    leaseId: string,
    credentialVersion: number,
    input: RotatedTokenInput,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET access_token_ciphertext = ?,
          access_token_nonce = ?,
          access_token_expires_at = ?,
          refresh_token_ciphertext = ?,
          refresh_token_nonce = ?,
          granted_scopes = ?,
          refreshed_at = ?,
          updated_at = ?,
          refresh_lease_id = NULL,
          refresh_lease_expires_at = NULL,
          refresh_dispatched_at = NULL,
          credential_version = credential_version + 1
      WHERE whoop_user_id = ? AND refresh_lease_id = ? AND credential_version = ?
        AND refresh_dispatched_at IS NOT NULL
    `).bind(
      input.accessToken.ciphertext,
      input.accessToken.nonce,
      input.accessTokenExpiresAt,
      input.refreshToken.ciphertext,
      input.refreshToken.nonce,
      input.grantedScopes.join(" "),
      input.refreshedAt,
      input.refreshedAt,
      whoopUserId,
      leaseId,
      credentialVersion,
    ).run();
    return changedRows(result) === 1;
  }

  async upsertSourceRecord<R extends WhoopResource>(
    resource: R,
    record: SourceRecordMap[R],
    options: {
      tombstonePolicy: TombstonePolicy;
      syncedAt?: string;
      whoopUserId?: number;
      connectionId?: string;
      reconcileGeneration?: number;
    },
  ): Promise<boolean> {
    if (options.tombstonePolicy !== "preserve" && options.tombstonePolicy !== "reconcile") {
      throw new Error("Invalid WHOOP tombstone policy");
    }
    const definition = sourceDefinitions[resource];
    const values = definition.values(
      record as SourceRecordMap[WhoopResource],
      canonicalTimestamp(options.syncedAt ?? new Date().toISOString())!,
    );
    const tombstoneLookup = options.tombstonePolicy === "preserve" && options.connectionId !== undefined
      ? webhookTombstoneLookup(resource, record as SourceRecordMap[WhoopResource])
      : null;
    const updates = definition.columns
      .filter((column) => column !== definition.keyColumn)
      .map((column) => {
        if (column === "deleted_at") {
          if (options.tombstonePolicy === "reconcile") return "deleted_at = NULL";
          if (!tombstoneLookup) return `deleted_at = ${definition.table}.deleted_at`;
          return `deleted_at = CASE
            WHEN ${definition.table}.deleted_at IS NULL THEN excluded.deleted_at
            WHEN excluded.deleted_at IS NULL THEN ${definition.table}.deleted_at
            WHEN ${definition.table}.deleted_at >= excluded.deleted_at THEN ${definition.table}.deleted_at
            ELSE excluded.deleted_at
          END`;
        }
        return `${column} = excluded.${column}`;
      })
      .join(",\n        ");
    const bindings: unknown[] = [];
    const valueExpressions = definition.columns.map((column, index) => {
      if (column === "deleted_at" && tombstoneLookup) {
        bindings.push(
          tombstoneLookup.whoopUserId,
          options.connectionId,
          tombstoneLookup.providerId,
          tombstoneLookup.eventType,
        );
        return `(SELECT MAX(received_at)
          FROM whoop_webhook_events
          WHERE whoop_user_id = ? AND connection_id = ?
            AND resource_id = CAST(? AS TEXT) AND event_type = ?)`;
      }
      bindings.push(values[index]);
      return "?";
    });
    const hasConnectionFence = options.whoopUserId !== undefined && options.connectionId !== undefined;
    const generationClause = options.reconcileGeneration === undefined
      ? ""
      : "AND reconcile_generation = ?";
    const insertExpression = hasConnectionFence
      ? `SELECT ${valueExpressions.join(", ")}
      WHERE EXISTS (
        SELECT 1 FROM whoop_connections
        WHERE whoop_user_id = ? AND connection_id = ?
          AND status IN ('active', 'backfilling')
          ${generationClause}
      )`
      : `VALUES (${valueExpressions.join(", ")})`;
    if (hasConnectionFence) {
      bindings.push(options.whoopUserId, options.connectionId);
      if (options.reconcileGeneration !== undefined) bindings.push(options.reconcileGeneration);
    }
    const updateCondition = hasConnectionFence
      ? `(excluded.upstream_updated_at >= ${definition.table}.upstream_updated_at
        OR ${definition.table}.upstream_updated_at IS NULL)
        AND EXISTS (
        SELECT 1 FROM whoop_connections
        WHERE whoop_user_id = ? AND connection_id = ?
          AND status IN ('active', 'backfilling')
          ${generationClause}
      )`
      : `excluded.upstream_updated_at >= ${definition.table}.upstream_updated_at
        OR ${definition.table}.upstream_updated_at IS NULL`;
    if (hasConnectionFence) {
      bindings.push(options.whoopUserId, options.connectionId);
      if (options.reconcileGeneration !== undefined) bindings.push(options.reconcileGeneration);
    }

    const result = await this.db.prepare(`
      INSERT INTO ${definition.table} (${definition.columns.join(", ")})
      ${insertExpression}
      ON CONFLICT(${definition.keyColumn}) DO UPDATE SET
        ${updates}
      WHERE ${updateCondition}
    `).bind(...bindings).run();
    if (hasConnectionFence && changedRows(result) === 0) {
      return options.reconcileGeneration === undefined
        ? this.isSyncConnectionCurrent(options.whoopUserId!, options.connectionId!)
        : this.isReconciliationCurrent(
            options.whoopUserId!,
            options.connectionId!,
            options.reconcileGeneration,
          );
    }
    return true;
  }

  async tombstoneSourceRecord(
    resource: WhoopResource,
    providerId: string | number,
    deletedAt: string,
    connection?: { whoopUserId: number; connectionId: string },
  ): Promise<boolean> {
    const definition = sourceDefinitions[resource];
    const canonicalDeletedAt = canonicalTimestamp(deletedAt)!;
    const result = await this.db.prepare(`
      UPDATE ${definition.table}
      SET deleted_at = ?, synced_at = ?
      WHERE ${definition.keyColumn} = ?
        ${connection ? `AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ?
            AND status IN ('active', 'backfilling')
        )` : ""}
    `).bind(
      canonicalDeletedAt,
      canonicalDeletedAt,
      providerId,
      ...(connection ? [connection.whoopUserId, connection.connectionId] : []),
    ).run();
    if (connection && changedRows(result) === 0) {
      return this.isSyncConnectionCurrent(connection.whoopUserId, connection.connectionId);
    }
    return true;
  }

  async createSyncRun(input: SyncRunInput): Promise<boolean> {
    const result = await this.db.prepare(`
      INSERT INTO whoop_sync_runs (
        run_id, whoop_user_id, connection_id, reconcile_generation, trigger, status,
        expected_target_count, completed_target_count, page_count, record_count,
        started_at, succeeded_at, failed_at, last_error
      ) SELECT ?, ?, ?, ?, ?, 'queued', ?, 0, 0, 0, ?, NULL, NULL, NULL
      WHERE EXISTS (
        SELECT 1 FROM whoop_connections
        WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
          AND status IN ('active', 'backfilling')
      )
    `).bind(
      input.runId,
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
      input.trigger,
      input.expectedTargetCount,
      canonicalTimestamp(input.startedAt)!,
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
    ).run();
    return changedRows(result) === 1;
  }

  async refreshSyncRun(
    runId: string,
    whoopUserId: number,
    connectionId: string,
    reconcileGeneration: number,
    updatedAt: string,
  ): Promise<boolean> {
    const timestamp = canonicalTimestamp(updatedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_sync_runs
      SET page_count = COALESCE((
            SELECT SUM(page_count) FROM whoop_sync_checkpoints
            WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
              AND sync_run_id = ? AND mode = 'reconcile'
          ), 0),
          record_count = COALESCE((
            SELECT SUM(record_count) FROM whoop_sync_checkpoints
            WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
              AND sync_run_id = ? AND mode = 'reconcile'
          ), 0),
          completed_target_count = COALESCE((
            SELECT SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END)
            FROM whoop_sync_checkpoints
            WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
              AND sync_run_id = ? AND mode = 'reconcile'
          ), 0),
          status = CASE
            WHEN (SELECT COUNT(*) FROM whoop_sync_checkpoints
                  WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
                    AND sync_run_id = ? AND mode = 'reconcile' AND status = 'error') > 0 THEN 'error'
            WHEN (SELECT COUNT(*) FROM whoop_sync_checkpoints
                  WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
                    AND sync_run_id = ? AND mode = 'reconcile' AND status = 'complete') >= expected_target_count
              THEN 'complete'
            WHEN (SELECT COUNT(*) FROM whoop_sync_checkpoints
                  WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
                    AND sync_run_id = ? AND mode = 'reconcile' AND status = 'retrying') > 0 THEN 'retrying'
            WHEN (SELECT COUNT(*) FROM whoop_sync_checkpoints
                  WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
                    AND sync_run_id = ? AND mode = 'reconcile') > 0 THEN 'running'
            ELSE 'queued'
          END,
          succeeded_at = CASE
            WHEN (SELECT COUNT(*) FROM whoop_sync_checkpoints
                  WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
                    AND sync_run_id = ? AND mode = 'reconcile' AND status = 'complete') >= expected_target_count
              THEN COALESCE(succeeded_at, ?) ELSE NULL END,
          failed_at = CASE
            WHEN (SELECT COUNT(*) FROM whoop_sync_checkpoints
                  WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
                    AND sync_run_id = ? AND mode = 'reconcile' AND status = 'error') > 0
              THEN COALESCE(failed_at, ?) ELSE NULL END,
          last_error = (
            SELECT last_error FROM whoop_sync_checkpoints
            WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
              AND sync_run_id = ? AND mode = 'reconcile' AND last_error IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1
          )
      WHERE run_id = ? AND whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
            AND status IN ('active', 'backfilling')
        )
    `).bind(
      whoopUserId, connectionId, reconcileGeneration, runId,
      whoopUserId, connectionId, reconcileGeneration, runId,
      whoopUserId, connectionId, reconcileGeneration, runId,
      whoopUserId, connectionId, reconcileGeneration, runId,
      whoopUserId, connectionId, reconcileGeneration, runId,
      whoopUserId, connectionId, reconcileGeneration, runId,
      whoopUserId, connectionId, reconcileGeneration, runId,
      whoopUserId, connectionId, reconcileGeneration, runId, timestamp,
      whoopUserId, connectionId, reconcileGeneration, runId, timestamp,
      whoopUserId, connectionId, reconcileGeneration, runId,
      runId, whoopUserId, connectionId, reconcileGeneration,
      whoopUserId, connectionId, reconcileGeneration,
    ).run();
    return changedRows(result) === 1;
  }

  async markSyncRunPublicationFailure(
    runId: string,
    whoopUserId: number,
    connectionId: string,
    reconcileGeneration: number,
    failedAt: string,
  ): Promise<boolean> {
    const timestamp = canonicalTimestamp(failedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_sync_runs
      SET status = 'error', failed_at = ?, last_error = 'WHOOP queue publication failed'
      WHERE run_id = ? AND whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
        AND status = 'queued'
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
            AND status IN ('active', 'backfilling')
        )
    `).bind(
      timestamp, runId, whoopUserId, connectionId, reconcileGeneration,
      whoopUserId, connectionId, reconcileGeneration,
    ).run();
    return changedRows(result) === 1;
  }

  async beginReconciliation(
    whoopUserId: number,
    connectionId: string,
    begunAt: string,
    requireActiveConnection = false,
  ): Promise<number | null> {
    const canonicalBegunAt = canonicalTimestamp(begunAt)!;
    const statusCondition = requireActiveConnection
      ? "status = 'active'"
      : "status IN ('active', 'backfilling')";
    const row = await this.db.prepare(`
      UPDATE whoop_connections
      SET reconcile_generation = reconcile_generation + 1,
          updated_at = ?
      WHERE whoop_user_id = ? AND connection_id = ?
        AND ${statusCondition}
      RETURNING reconcile_generation
    `).bind(canonicalBegunAt, whoopUserId, connectionId)
      .first<{ reconcile_generation: number }>();
    if (!row) return null;
    await this.db.prepare(`
      DELETE FROM whoop_reconcile_seen
      WHERE whoop_user_id = ? AND connection_id = ?
        AND reconcile_generation < ?
    `).bind(whoopUserId, connectionId, row.reconcile_generation).run();
    return row.reconcile_generation;
  }

  async upsertCheckpoint(input: CheckpointInput): Promise<boolean> {
    const result = await this.checkpointStatement(input).run();
    if (changedRows(result) === 0) {
      return input.mode === "reconcile"
        ? this.isReconciliationCurrent(
            input.whoopUserId,
            input.connectionId,
            input.reconcileGeneration,
          )
        : this.isSyncConnectionCurrent(input.whoopUserId, input.connectionId);
    }
    return true;
  }

  private checkpointStatement(input: CheckpointInput): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO whoop_sync_checkpoints (
        whoop_user_id, connection_id, resource, mode, reconcile_generation, sync_run_id, target_id,
        window_start, window_end, next_token, status,
        page_count, record_count, created_at, updated_at, last_error
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM whoop_connections
        WHERE whoop_user_id = ? AND connection_id = ?
          AND status IN ('active', 'backfilling')
          AND (? != 'reconcile' OR reconcile_generation = ?)
      )
      ON CONFLICT(whoop_user_id, connection_id, resource, mode, reconcile_generation, sync_run_id, target_id) DO UPDATE SET
        window_start = excluded.window_start,
        window_end = excluded.window_end,
        next_token = excluded.next_token,
        status = excluded.status,
        page_count = excluded.page_count,
        record_count = excluded.record_count,
        updated_at = excluded.updated_at,
        last_error = excluded.last_error
      WHERE EXISTS (
        SELECT 1 FROM whoop_connections
        WHERE whoop_user_id = ? AND connection_id = ?
          AND status IN ('active', 'backfilling')
          AND (? != 'reconcile' OR reconcile_generation = ?)
      )
        AND (
          excluded.page_count > whoop_sync_checkpoints.page_count
          OR (
            excluded.page_count = whoop_sync_checkpoints.page_count
            AND excluded.record_count > whoop_sync_checkpoints.record_count
          )
          OR (
            excluded.page_count = whoop_sync_checkpoints.page_count
            AND excluded.record_count = whoop_sync_checkpoints.record_count
            AND CASE excluded.status
              WHEN 'complete' THEN 3
              WHEN 'error' THEN 2
              WHEN 'retrying' THEN 1
              ELSE 0
            END > CASE whoop_sync_checkpoints.status
              WHEN 'complete' THEN 3
              WHEN 'error' THEN 2
              WHEN 'retrying' THEN 1
              ELSE 0
            END
          )
        )
    `).bind(
      input.whoopUserId,
      input.connectionId,
      input.resource,
      input.mode,
      input.reconcileGeneration,
      input.syncRunId,
      input.targetId,
      canonicalTimestamp(input.windowStart),
      canonicalTimestamp(input.windowEnd),
      input.nextToken ?? null,
      input.status,
      input.pageCount,
      input.recordCount,
      canonicalTimestamp(input.createdAt)!,
      canonicalTimestamp(input.updatedAt)!,
      sanitizedError(input.lastError),
      input.whoopUserId,
      input.connectionId,
      input.mode,
      input.reconcileGeneration,
      input.whoopUserId,
      input.connectionId,
      input.mode,
      input.reconcileGeneration,
    );
  }

  async recordReconciliationSeen(input: ReconciliationSeenInput): Promise<boolean> {
    const seenAt = canonicalTimestamp(input.seenAt)!;
    const result = await this.db.prepare(`
      INSERT INTO whoop_reconcile_seen (
        whoop_user_id, connection_id, reconcile_generation,
        reconcile_run_id, resource, provider_id, seen_at
      ) SELECT ?, ?, ?, ?, ?, CAST(? AS TEXT), ?
      WHERE EXISTS (
        SELECT 1 FROM whoop_connections
        WHERE whoop_user_id = ? AND connection_id = ?
          AND status IN ('active', 'backfilling')
          AND reconcile_generation = ?
      )
      ON CONFLICT(whoop_user_id, connection_id, reconcile_generation, reconcile_run_id, resource, provider_id)
      DO UPDATE SET seen_at = excluded.seen_at
      WHERE EXISTS (
        SELECT 1 FROM whoop_connections
        WHERE whoop_user_id = ? AND connection_id = ?
          AND status IN ('active', 'backfilling')
          AND reconcile_generation = ?
      )
    `).bind(
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
      input.reconcileRunId,
      input.resource,
      input.providerId,
      seenAt,
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
    ).run();
    if (changedRows(result) === 0) {
      return this.isReconciliationCurrent(
        input.whoopUserId,
        input.connectionId,
        input.reconcileGeneration,
      );
    }
    return true;
  }

  async cleanupReconciliationSeen(input: {
    whoopUserId: number;
    connectionId: string;
    reconcileGeneration: number;
    reconcileRunId: string;
    resource: WhoopResource;
  }): Promise<boolean> {
    const current = await this.isReconciliationCurrent(
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
    );
    if (!current) return false;
    await this.db.prepare(`
      DELETE FROM whoop_reconcile_seen
      WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
        AND reconcile_run_id = ? AND resource = ?
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
            AND status IN ('active', 'backfilling')
        )
    `).bind(
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
      input.reconcileRunId,
      input.resource,
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
    ).run();
    return this.isReconciliationCurrent(
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
    );
  }

  async finalizeReconciliation(input: CheckpointInput): Promise<boolean> {
    if (input.mode !== "reconcile"
      || input.targetId !== ""
      || input.windowStart == null
      || input.windowEnd == null
      || !(input.resource in reconciliationDefinitions)) {
      throw new Error("Invalid WHOOP reconciliation finalization");
    }
    const resource = input.resource as keyof typeof reconciliationDefinitions;
    const definition = reconciliationDefinitions[resource];
    const completedAt = canonicalTimestamp(input.updatedAt)!;
    const windowStart = canonicalTimestamp(input.windowStart)!;
    const windowEnd = canonicalTimestamp(input.windowEnd)!;
    const tombstone = this.db.prepare(`
      UPDATE ${definition.table}
      SET deleted_at = ?, synced_at = ?
      WHERE whoop_user_id = ? AND deleted_at IS NULL
        AND ${definition.windowColumn} >= ? AND ${definition.windowColumn} <= ?
        AND ${definition.syncedColumn} <= ?
        AND CAST(${definition.keyColumn} AS TEXT) NOT IN (
          SELECT provider_id
          FROM whoop_reconcile_seen
          WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
            AND reconcile_run_id = ? AND resource = ?
        )
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
            AND status IN ('active', 'backfilling')
        )
        AND NOT EXISTS (
          SELECT 1 FROM whoop_sync_checkpoints
          WHERE whoop_user_id = ? AND connection_id = ? AND resource = ?
            AND mode = 'reconcile' AND reconcile_generation = ?
            AND sync_run_id = ? AND target_id = ''
            AND (
              page_count > ?
              OR (page_count = ? AND record_count > ?)
              OR (page_count = ? AND record_count = ? AND status = 'complete')
            )
        )
    `).bind(
      completedAt,
      completedAt,
      input.whoopUserId,
      windowStart,
      windowEnd,
      windowEnd,
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
      input.syncRunId,
      resource,
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
      input.whoopUserId,
      input.connectionId,
      resource,
      input.reconcileGeneration,
      input.syncRunId,
      input.pageCount,
      input.pageCount,
      input.recordCount,
      input.pageCount,
      input.recordCount,
    );
    const cleanup = this.db.prepare(`
      DELETE FROM whoop_reconcile_seen
      WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
        AND reconcile_run_id = ? AND resource = ?
        AND EXISTS (
          SELECT 1 FROM whoop_sync_checkpoints
          WHERE whoop_user_id = ? AND connection_id = ? AND resource = ?
            AND mode = 'reconcile' AND reconcile_generation = ?
            AND sync_run_id = ? AND target_id = ''
            AND status = 'complete' AND page_count >= ?
        )
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
            AND status IN ('active', 'backfilling')
        )
    `).bind(
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
      input.syncRunId,
      resource,
      input.whoopUserId,
      input.connectionId,
      resource,
      input.reconcileGeneration,
      input.syncRunId,
      input.pageCount,
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
    );
    const completed = this.db.prepare(`
      UPDATE whoop_sync_checkpoints
      SET updated_at = updated_at
      WHERE whoop_user_id = ? AND connection_id = ? AND resource = ?
        AND mode = 'reconcile' AND reconcile_generation = ?
        AND sync_run_id = ? AND target_id = ''
        AND status = 'complete' AND page_count >= ?
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
            AND status IN ('active', 'backfilling')
        )
    `).bind(
      input.whoopUserId,
      input.connectionId,
      resource,
      input.reconcileGeneration,
      input.syncRunId,
      input.pageCount,
      input.whoopUserId,
      input.connectionId,
      input.reconcileGeneration,
    );
    const results = await this.db.batch([
      tombstone,
      this.checkpointStatement(input),
      cleanup,
      completed,
    ]);
    return changedRows(results.at(-1)!) > 0;
  }

  async recordWebhookEvent(input: WebhookEventInput): Promise<boolean> {
    const result = await this.db.prepare(`
      INSERT INTO whoop_webhook_events (
        trace_id, whoop_user_id, connection_id, resource_id, event_type, received_at,
        processed_at, status, attempts, last_error
      ) SELECT ?, ?, ?, ?, ?, ?, NULL, 'received', 0, NULL
      WHERE EXISTS (
        SELECT 1 FROM whoop_connections
        WHERE whoop_user_id = ? AND connection_id = ?
          AND status IN ('active', 'backfilling')
      )
      ON CONFLICT(trace_id) DO NOTHING
    `).bind(
      input.traceId,
      input.whoopUserId,
      input.connectionId,
      input.resourceId,
      input.eventType,
      canonicalTimestamp(input.receivedAt)!,
      input.whoopUserId,
      input.connectionId,
    ).run();
    return changedRows(result) === 1;
  }

  async markWebhookQueued(
    traceId: string,
    whoopUserId: number,
    connectionId: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE whoop_webhook_events
      SET status = 'queued'
      WHERE trace_id = ? AND whoop_user_id = ? AND connection_id = ? AND status = 'received'
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ?
            AND status IN ('active', 'backfilling')
        )
    `).bind(traceId, whoopUserId, connectionId, whoopUserId, connectionId).run();
    return changedRows(result) === 1;
  }

  async getWebhookEventStatus(
    traceId: string,
    whoopUserId: number,
    connectionId: string,
  ): Promise<WebhookEventStatus | null> {
    const row = await this.db.prepare(`
      SELECT event.status
      FROM whoop_webhook_events AS event
      WHERE event.trace_id = ? AND event.whoop_user_id = ? AND event.connection_id = ?
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ?
            AND status IN ('active', 'backfilling')
        )
    `).bind(traceId, whoopUserId, connectionId, whoopUserId, connectionId)
      .first<{ status: WebhookEventStatus }>();
    return row?.status ?? null;
  }

  async markWebhookProcessed(
    traceId: string,
    whoopUserId: number,
    connectionId: string,
    processedAt: string,
  ): Promise<boolean> {
    const timestamp = canonicalTimestamp(processedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_webhook_events
      SET status = 'processed', processed_at = ?, attempts = attempts + 1, last_error = NULL
      WHERE trace_id = ? AND whoop_user_id = ? AND connection_id = ?
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ?
            AND status IN ('active', 'backfilling')
        )
    `).bind(
      timestamp,
      traceId,
      whoopUserId,
      connectionId,
      whoopUserId,
      connectionId,
    ).run();
    return changedRows(result) === 1;
  }

  async markWebhookFailed(
    traceId: string,
    whoopUserId: number,
    connectionId: string,
    status: "retrying" | "error",
    lastError: string,
    failedAt: string,
  ): Promise<boolean> {
    const timestamp = canonicalTimestamp(failedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_webhook_events
      SET status = ?,
          processed_at = CASE WHEN ? = 'error' THEN ? ELSE processed_at END,
          attempts = attempts + 1,
          last_error = ?
      WHERE trace_id = ? AND whoop_user_id = ? AND connection_id = ?
        AND EXISTS (
          SELECT 1 FROM whoop_connections
          WHERE whoop_user_id = ? AND connection_id = ?
            AND status IN ('active', 'backfilling')
        )
    `).bind(
      status,
      status,
      timestamp,
      sanitizedError(lastError),
      traceId,
      whoopUserId,
      connectionId,
      whoopUserId,
      connectionId,
    ).run();
    return changedRows(result) === 1;
  }

  async getConnectionStatus(whoopUserId: number): Promise<ConnectionStatusProjection> {
    const row = await this.db.prepare(`
      SELECT status, granted_scopes, connected_at, refreshed_at, last_success_at,
             last_error_at, disconnected_at, last_error, consecutive_failure_count, updated_at
      FROM whoop_connections
      WHERE whoop_user_id = ?
    `).bind(whoopUserId).first<{
      status: Exclude<WhoopConnectionStatus, "not_connected">;
      granted_scopes: string;
      connected_at: string | null;
      refreshed_at: string | null;
      last_success_at: string | null;
      last_error_at: string | null;
      disconnected_at: string | null;
      last_error: string | null;
      consecutive_failure_count: number;
      updated_at: string;
    }>();
    if (!row) return { status: "not_connected" };
    return {
      ...row,
      granted_scopes: row.granted_scopes.split(/\s+/).filter(Boolean),
      last_error: sanitizedError(row.last_error),
    };
  }

  async getCurrentConnection(): Promise<CurrentWhoopConnection | null> {
    const row = await this.db.prepare(`
      SELECT whoop_user_id, connection_id, status, granted_scopes, credential_version,
             reconcile_generation, connected_at, refreshed_at, last_success_at,
             last_error_at, disconnected_at, last_error, consecutive_failure_count, updated_at
      FROM whoop_connections
      ORDER BY CASE WHEN status = 'disconnected' THEN 1 ELSE 0 END,
               connected_at DESC, whoop_user_id DESC
      LIMIT 1
    `).first<{
      whoop_user_id: number;
      connection_id: string;
      status: Exclude<WhoopConnectionStatus, "not_connected">;
      granted_scopes: string;
      credential_version: number;
      reconcile_generation: number;
      connected_at: string | null;
      refreshed_at: string | null;
      last_success_at: string | null;
      last_error_at: string | null;
      disconnected_at: string | null;
      last_error: string | null;
      consecutive_failure_count: number;
      updated_at: string;
    }>();
    if (!row) return null;
    return {
      whoopUserId: row.whoop_user_id,
      connectionId: row.connection_id,
      credentialVersion: row.credential_version,
      reconcileGeneration: row.reconcile_generation,
      status: row.status,
      granted_scopes: row.granted_scopes.split(/\s+/).filter(Boolean),
      connected_at: row.connected_at,
      refreshed_at: row.refreshed_at,
      last_success_at: row.last_success_at,
      last_error_at: row.last_error_at,
      disconnected_at: row.disconnected_at,
      last_error: sanitizedError(row.last_error),
      consecutive_failure_count: row.consecutive_failure_count,
      updated_at: row.updated_at,
    };
  }

  async disconnect(
    whoopUserId: number,
    credentialVersion: number,
    disconnectedAt: string,
  ): Promise<boolean> {
    const timestamp = canonicalTimestamp(disconnectedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET status = 'disconnected',
          access_token_ciphertext = NULL,
          access_token_nonce = NULL,
          access_token_expires_at = NULL,
          refresh_token_ciphertext = NULL,
          refresh_token_nonce = NULL,
          refresh_lease_id = NULL,
          refresh_lease_expires_at = NULL,
          refresh_dispatched_at = NULL,
          disconnected_at = ?,
          updated_at = ?
      WHERE whoop_user_id = ? AND credential_version = ? AND status != 'disconnected'
    `).bind(timestamp, timestamp, whoopUserId, credentialVersion).run();
    return changedRows(result) === 1;
  }

  async deleteLocalData(whoopUserId: number, credentialVersion: number): Promise<boolean> {
    const guard = `EXISTS (
      SELECT 1 FROM whoop_connections
      WHERE whoop_user_id = ? AND credential_version = ? AND status = 'disconnected'
    )`;
    const userTables = [
      "whoop_profiles",
      "whoop_body_measurements",
      "whoop_cycles",
      "whoop_recoveries",
      "whoop_sleeps",
      "whoop_workouts",
      "whoop_webhook_events",
      "whoop_reconcile_seen",
      "whoop_sync_checkpoints",
      "whoop_sync_runs",
    ];
    const results = await this.db.batch([
      this.db.prepare(`DELETE FROM whoop_oauth_states WHERE ${guard}`)
        .bind(whoopUserId, credentialVersion),
      ...userTables.map((table) => this.db.prepare(
        `DELETE FROM ${table} WHERE whoop_user_id = ? AND ${guard}`,
      ).bind(whoopUserId, whoopUserId, credentialVersion)),
      this.db.prepare(`
        DELETE FROM whoop_connections
        WHERE whoop_user_id = ? AND credential_version = ? AND status = 'disconnected'
      `).bind(whoopUserId, credentialVersion),
    ]);
    return changedRows(results.at(-1)!) === 1;
  }

  async getSyncProgress(whoopUserId: number): Promise<SyncProgressProjection[]> {
    const result = await this.db.prepare(`
      SELECT resource, mode, status, page_count, record_count, updated_at, last_error
      FROM (
        SELECT checkpoint.resource, checkpoint.mode, checkpoint.status,
               checkpoint.page_count, checkpoint.record_count, checkpoint.updated_at,
               checkpoint.last_error,
               ROW_NUMBER() OVER (
                 PARTITION BY checkpoint.resource, checkpoint.mode
                 ORDER BY checkpoint.reconcile_generation DESC,
                          checkpoint.created_at DESC,
                          checkpoint.page_count DESC,
                          checkpoint.record_count DESC
               ) AS row_number
        FROM whoop_sync_checkpoints AS checkpoint
        INNER JOIN whoop_connections AS connection
          ON connection.whoop_user_id = checkpoint.whoop_user_id
         AND connection.connection_id = checkpoint.connection_id
        WHERE checkpoint.whoop_user_id = ? AND checkpoint.target_id = ''
      )
      WHERE row_number = 1
      ORDER BY resource ASC, mode ASC
    `).bind(whoopUserId).all<SyncProgressProjection>();
    return result.results.map((row) => ({ ...row, last_error: sanitizedError(row.last_error) }));
  }

  async getRecentSyncRuns(whoopUserId: number, limit = 10): Promise<SyncRunProjection[]> {
    const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    const result = await this.db.prepare(`
      SELECT run.run_id, run.trigger, run.status, run.page_count, run.record_count,
             run.expected_target_count, run.completed_target_count, run.started_at,
             run.succeeded_at, run.failed_at, run.last_error
      FROM whoop_sync_runs AS run
      INNER JOIN whoop_connections AS connection
        ON connection.whoop_user_id = run.whoop_user_id
       AND connection.connection_id = run.connection_id
      WHERE run.whoop_user_id = ?
      ORDER BY run.started_at DESC, run.run_id DESC
      LIMIT ?
    `).bind(whoopUserId, boundedLimit).all<SyncRunProjection>();
    return result.results.map((run) => ({ ...run, last_error: sanitizedError(run.last_error) }));
  }

  async recordSyncSuccess(
    whoopUserId: number,
    connectionId: string,
    succeededAt: string,
  ): Promise<boolean> {
    const timestamp = canonicalTimestamp(succeededAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET last_success_at = ?, last_error_at = NULL, last_error = NULL,
          consecutive_failure_count = 0, updated_at = ?
      WHERE whoop_user_id = ? AND connection_id = ?
        AND status IN ('active', 'backfilling')
    `).bind(timestamp, timestamp, whoopUserId, connectionId).run();
    return changedRows(result) === 1;
  }

  async recordSyncFailure(
    whoopUserId: number,
    connectionId: string,
    failedAt: string,
    lastError: string,
  ): Promise<boolean> {
    const timestamp = canonicalTimestamp(failedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET last_error_at = ?, last_error = ?,
          consecutive_failure_count = consecutive_failure_count + 1, updated_at = ?
      WHERE whoop_user_id = ? AND connection_id = ?
        AND status IN ('active', 'backfilling')
    `).bind(
      timestamp,
      sanitizedError(lastError) ?? "WHOOP synchronization failed",
      timestamp,
      whoopUserId,
      connectionId,
    ).run();
    return changedRows(result) === 1;
  }

  async pruneOperationalData(now: string): Promise<{
    oauthStates: number;
    checkpoints: number;
    runs: number;
    seen: number;
    webhookReceipts: number;
  }> {
    const nowMilliseconds = Date.parse(canonicalTimestamp(now)!);
    const cutoff = (milliseconds: number) => new Date(nowMilliseconds - milliseconds).toISOString();
    const oauthCutoff = cutoff(WHOOP_OPERATIONAL_RETENTION.oauthStateMilliseconds);
    const checkpointCutoff = cutoff(WHOOP_OPERATIONAL_RETENTION.checkpointMilliseconds);
    const runCutoff = cutoff(WHOOP_OPERATIONAL_RETENTION.syncRunMilliseconds);
    const seenCutoff = cutoff(WHOOP_OPERATIONAL_RETENTION.reconcileSeenMilliseconds);
    const webhookCutoff = cutoff(WHOOP_OPERATIONAL_RETENTION.processedWebhookMilliseconds);
    const limit = WHOOP_OPERATIONAL_RETENTION.deleteLimit;
    const results = await this.db.batch([
      this.db.prepare(`
        DELETE FROM whoop_oauth_states WHERE rowid IN (
          SELECT rowid FROM whoop_oauth_states
          WHERE (consumed_at IS NOT NULL AND consumed_at < ?)
             OR (expires_at < ?)
          ORDER BY expires_at ASC LIMIT ?
        )
      `).bind(oauthCutoff, oauthCutoff, limit),
      this.db.prepare(`
        DELETE FROM whoop_sync_checkpoints WHERE rowid IN (
          SELECT checkpoint.rowid FROM whoop_sync_checkpoints AS checkpoint
          WHERE checkpoint.status IN ('complete', 'error') AND checkpoint.updated_at < ?
            AND (checkpoint.target_id != '' OR EXISTS (
              SELECT 1 FROM whoop_sync_checkpoints AS newer
              WHERE newer.whoop_user_id = checkpoint.whoop_user_id
                AND newer.resource = checkpoint.resource
                AND newer.mode = checkpoint.mode
                AND newer.target_id = checkpoint.target_id
                AND (newer.created_at > checkpoint.created_at
                  OR (newer.created_at = checkpoint.created_at AND newer.sync_run_id > checkpoint.sync_run_id))
            ))
          ORDER BY checkpoint.updated_at ASC LIMIT ?
        )
      `).bind(checkpointCutoff, limit),
      this.db.prepare(`
        DELETE FROM whoop_sync_runs WHERE rowid IN (
          SELECT run.rowid FROM whoop_sync_runs AS run
          WHERE run.status IN ('complete', 'error') AND run.started_at < ?
            AND EXISTS (
              SELECT 1 FROM whoop_sync_runs AS newer
              WHERE newer.whoop_user_id = run.whoop_user_id
                AND (newer.started_at > run.started_at
                  OR (newer.started_at = run.started_at AND newer.run_id > run.run_id))
            )
          ORDER BY run.started_at ASC LIMIT ?
        )
      `).bind(runCutoff, limit),
      this.db.prepare(`
        DELETE FROM whoop_reconcile_seen WHERE rowid IN (
          SELECT seen.rowid FROM whoop_reconcile_seen AS seen
          WHERE seen.seen_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM whoop_sync_checkpoints AS checkpoint
              WHERE checkpoint.whoop_user_id = seen.whoop_user_id
                AND checkpoint.connection_id = seen.connection_id
                AND checkpoint.reconcile_generation = seen.reconcile_generation
                AND checkpoint.sync_run_id = seen.reconcile_run_id
                AND checkpoint.status IN ('queued', 'running', 'retrying')
            )
          ORDER BY seen.seen_at ASC LIMIT ?
        )
      `).bind(seenCutoff, limit),
      this.db.prepare(`
        DELETE FROM whoop_webhook_events WHERE rowid IN (
          SELECT rowid FROM whoop_webhook_events
          WHERE status = 'processed' AND processed_at < ?
            AND event_type IN ('workout.updated', 'sleep.updated', 'recovery.updated')
          ORDER BY processed_at ASC LIMIT ?
        )
      `).bind(webhookCutoff, limit),
    ]);
    return {
      oauthStates: changedRows(results[0]),
      checkpoints: changedRows(results[1]),
      runs: changedRows(results[2]),
      seen: changedRows(results[3]),
      webhookReceipts: changedRows(results[4]),
    };
  }

  async getPendingRecoveryCycleIds(whoopUserId: number, limit = 25): Promise<number[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new Error("WHOOP pending recovery limit must be an integer from 1 to 25");
    }
    const result = await this.db.prepare(`
      SELECT recovery.cycle_id
      FROM whoop_recoveries AS recovery
      INNER JOIN whoop_connections AS connection
        ON connection.whoop_user_id = recovery.whoop_user_id
      WHERE recovery.whoop_user_id = ?
        AND recovery.deleted_at IS NULL
        AND recovery.score_state IN ('PENDING_SCORE', 'UNSCORABLE')
        AND connection.status IN ('active', 'backfilling')
      GROUP BY recovery.cycle_id
      ORDER BY MIN(COALESCE((
        SELECT MAX(checkpoint.updated_at)
        FROM whoop_sync_checkpoints AS checkpoint
        WHERE checkpoint.whoop_user_id = recovery.whoop_user_id
          AND checkpoint.connection_id = connection.connection_id
          AND checkpoint.resource = 'recovery'
          AND checkpoint.reconcile_generation = connection.reconcile_generation
          AND checkpoint.target_id = 'recovery-cycle:' || CAST(recovery.cycle_id AS TEXT)
      ), recovery.synced_at)) ASC,
      recovery.cycle_id ASC
      LIMIT ?
    `).bind(whoopUserId, limit).all<{ cycle_id: number }>();
    return result.results.map((row) => row.cycle_id);
  }

  async isSyncConnectionCurrent(whoopUserId: number, connectionId: string): Promise<boolean> {
    const row = await this.db.prepare(`
      SELECT 1 AS current
      FROM whoop_connections
      WHERE whoop_user_id = ? AND connection_id = ?
        AND status IN ('active', 'backfilling')
    `).bind(whoopUserId, connectionId).first<{ current: number }>();
    return row?.current === 1;
  }

  async isReconciliationCurrent(
    whoopUserId: number,
    connectionId: string,
    reconcileGeneration: number,
  ): Promise<boolean> {
    const row = await this.db.prepare(`
      SELECT 1 AS current
      FROM whoop_connections
      WHERE whoop_user_id = ? AND connection_id = ? AND reconcile_generation = ?
        AND status IN ('active', 'backfilling')
    `).bind(whoopUserId, connectionId, reconcileGeneration).first<{ current: number }>();
    return row?.current === 1;
  }

  async activateCompletedBackfill(
    whoopUserId: number,
    connectionId: string,
    completedAt: string,
  ): Promise<boolean> {
    const timestamp = canonicalTimestamp(completedAt)!;
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET status = 'active',
          last_success_at = ?,
          last_error = NULL,
          consecutive_failure_count = 0,
          updated_at = ?
      WHERE whoop_user_id = ? AND connection_id = ?
        AND status = 'backfilling'
        AND initial_backfill_pending = 0
        AND 6 = (
          SELECT COUNT(DISTINCT resource)
          FROM whoop_sync_checkpoints
          WHERE whoop_user_id = ? AND connection_id = ?
            AND mode = 'backfill' AND reconcile_generation = 0
            AND target_id = '' AND status = 'complete'
            AND resource IN ('profile', 'body_measurement', 'cycle', 'recovery', 'sleep', 'workout')
        )
    `).bind(timestamp, timestamp, whoopUserId, connectionId, whoopUserId, connectionId).run();
    return changedRows(result) === 1;
  }

  async withWhoopAccessToken<T>(
    whoopUserId: number,
    request: AccessTokenRequest<T>,
    refresh: RefreshTokenRequest,
    options: AccessTokenOptions = {},
  ): Promise<T> {
    const now = options.now ?? (() => new Date());
    const createLeaseId = options.leaseId ?? (() => crypto.randomUUID());
    const sleep = options.sleep ?? defaultSleep;
    const initial = await this.requireTokenConnection(whoopUserId);
    if (options.expectedConnectionId !== undefined
      && initial.connection_id !== options.expectedConnectionId) {
      throw new WhoopStaleConnectionError();
    }
    const initialCredentialVersion = initial.credential_version;
    const initialAccessToken = await this.decryptToken(initial, "access");
    const refreshBeforeExpirationMilliseconds = options.refreshBeforeExpirationMilliseconds;
    if (refreshBeforeExpirationMilliseconds !== undefined
      && (!Number.isFinite(refreshBeforeExpirationMilliseconds)
        || refreshBeforeExpirationMilliseconds < 0)) {
      throw new Error("WHOOP refresh-before-expiration window is invalid");
    }
    const accessTokenExpiresAt = initial.access_token_expires_at === null
      ? Number.NaN
      : Date.parse(initial.access_token_expires_at);
    const proactiveRefresh = refreshBeforeExpirationMilliseconds !== undefined
      && (!Number.isFinite(accessTokenExpiresAt)
        || accessTokenExpiresAt <= now().getTime() + refreshBeforeExpirationMilliseconds);

    if (!proactiveRefresh) {
      try {
        return await request(initialAccessToken, initialCredentialVersion);
      } catch (error) {
        if (!(error instanceof WhoopUnauthorizedError)) throw error;
      }
    }

    const leaseId = createLeaseId();
    const refreshStartedAt = now();
    const ownsLease = await this.acquireRefreshLease(
      whoopUserId,
      leaseId,
      refreshStartedAt.toISOString(),
      initialCredentialVersion,
    );
    let retryAccessToken: string;
    let retryCredentialVersion: number;

    if (ownsLease) {
      let ordinaryReleaseAllowed = true;
      try {
        const latest = await this.findOwnedRefreshLease(
          whoopUserId,
          initialCredentialVersion,
          leaseId,
          now().toISOString(),
        );
        if (!latest) throw new Error("WHOOP refresh lease ownership was lost before refresh");
        const latestRefreshToken = await this.decryptToken(latest, "refresh");
        const abortAt = refreshStartedAt.getTime() + REFRESH_ABORT_MILLISECONDS;
        const millisecondsUntilAbort = abortAt - now().getTime();
        if (millisecondsUntilAbort <= 0) {
          throw new Error("WHOOP refresh deadline elapsed before dispatch");
        }
        const dispatched = await this.markRefreshDispatched(
          whoopUserId,
          leaseId,
          initialCredentialVersion,
          now().toISOString(),
        );
        if (!dispatched) throw new Error("WHOOP refresh lease ownership was lost before dispatch");
        ordinaryReleaseAllowed = false;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort(new DOMException("WHOOP token refresh timed out", "TimeoutError"));
        }, millisecondsUntilAbort);
        let tokens: WhoopTokenResponse;
        try {
          tokens = await refresh(latestRefreshToken, { signal: controller.signal });
        } catch (error) {
          if (isDefiniteRefreshFailure(error)) {
            const cleared = await this.clearDefiniteRefreshFailure(
              whoopUserId,
              leaseId,
              initialCredentialVersion,
              now().toISOString(),
            );
            if (!cleared) throw new Error("WHOOP refresh dispatch ownership was lost");
            throw error;
          }
          await this.quarantineAmbiguousRefresh(
            whoopUserId,
            initialCredentialVersion,
            leaseId,
            now().toISOString(),
          );
          throw ambiguousRefreshFailure(error);
        } finally {
          clearTimeout(timeoutId);
        }
        try {
          const rotatedAt = now();
          const [accessToken, refreshToken] = await Promise.all([
            encryptWhoopToken(this.tokenEncryptionKey, whoopUserId, "access", tokens.access_token),
            encryptWhoopToken(this.tokenEncryptionKey, whoopUserId, "refresh", tokens.refresh_token),
          ]);
          const stored = await this.storeRotatedTokens(whoopUserId, leaseId, initialCredentialVersion, {
            accessToken,
            accessTokenExpiresAt: new Date(rotatedAt.getTime() + tokens.expires_in * 1000).toISOString(),
            refreshToken,
            grantedScopes: tokens.scope?.split(/\s+/).filter(Boolean)
              ?? latest.granted_scopes.split(/\s+/).filter(Boolean),
            refreshedAt: rotatedAt.toISOString(),
          });
          if (!stored) throw new Error("WHOOP rotated token storage was not committed");
        } catch (error) {
          await this.quarantineAmbiguousRefresh(
            whoopUserId,
            initialCredentialVersion,
            leaseId,
            now().toISOString(),
          );
          throw ambiguousRefreshFailure(error);
        }
        retryAccessToken = tokens.access_token;
        retryCredentialVersion = initialCredentialVersion + 1;
      } finally {
        if (ordinaryReleaseAllowed) {
          await this.releaseRefreshLease(
            whoopUserId,
            leaseId,
            initialCredentialVersion,
            now().toISOString(),
          );
        }
      }
    } else {
      await sleep(REFRESH_WAIT_MILLISECONDS);
      const reread = await this.requireTokenConnection(whoopUserId);
      if (options.expectedConnectionId !== undefined
        && reread.connection_id !== options.expectedConnectionId) {
        throw new WhoopStaleConnectionError();
      }
      retryAccessToken = await this.decryptToken(reread, "access");
      retryCredentialVersion = reread.credential_version;
      if (retryAccessToken === initialAccessToken) {
        throw new Error("WHOOP access token refresh is still in progress");
      }
    }

    try {
      return await request(retryAccessToken, retryCredentialVersion);
    } catch (error) {
      if (error instanceof WhoopUnauthorizedError) {
        await this.markNeedsReauth(whoopUserId, retryCredentialVersion, now().toISOString());
      }
      throw error;
    }
  }

  private async requireTokenConnection(whoopUserId: number): Promise<TokenConnectionRow> {
    const row = await this.db.prepare(`
      SELECT whoop_user_id, connection_id, status, access_token_ciphertext, access_token_nonce,
             access_token_expires_at, refresh_token_ciphertext, refresh_token_nonce,
             granted_scopes, credential_version
      FROM whoop_connections
      WHERE whoop_user_id = ?
    `).bind(whoopUserId).first<TokenConnectionRow>();
    if (!row) throw new Error("WHOOP connection is not available");
    return row;
  }

  private async findOwnedRefreshLease(
    whoopUserId: number,
    credentialVersion: number,
    leaseId: string,
    now: string,
  ): Promise<TokenConnectionRow | null> {
    return this.db.prepare(`
      SELECT whoop_user_id, connection_id, status, access_token_ciphertext, access_token_nonce,
             access_token_expires_at, refresh_token_ciphertext, refresh_token_nonce,
             granted_scopes, credential_version
      FROM whoop_connections
      WHERE whoop_user_id = ? AND credential_version = ?
        AND status IN ('active', 'backfilling')
        AND refresh_dispatched_at IS NULL
        AND refresh_lease_id = ? AND refresh_lease_expires_at > ?
    `).bind(whoopUserId, credentialVersion, leaseId, now).first<TokenConnectionRow>();
  }

  private async decryptToken(row: TokenConnectionRow, kind: "access" | "refresh"): Promise<string> {
    const ciphertext = kind === "access" ? row.access_token_ciphertext : row.refresh_token_ciphertext;
    const nonce = kind === "access" ? row.access_token_nonce : row.refresh_token_nonce;
    if (!ciphertext || !nonce) throw new Error("WHOOP connection token is not available");
    return decryptWhoopToken(this.tokenEncryptionKey, row.whoop_user_id, kind, { ciphertext, nonce });
  }

  private async markNeedsReauth(whoopUserId: number, credentialVersion: number, now: string): Promise<void> {
    await this.db.prepare(`
      UPDATE whoop_connections
      SET status = 'needs_reauth', last_error_at = ?, updated_at = ?
      WHERE whoop_user_id = ? AND credential_version = ?
    `).bind(now, now, whoopUserId, credentialVersion).run();
  }

  private async quarantineAmbiguousRefresh(
    whoopUserId: number,
    credentialVersion: number,
    leaseId: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE whoop_connections
      SET status = 'needs_reauth',
          last_error_at = ?,
          updated_at = ?,
          last_error = 'WHOOP token refresh outcome is unknown',
          refresh_lease_id = NULL,
          refresh_lease_expires_at = NULL
      WHERE whoop_user_id = ? AND refresh_lease_id = ? AND credential_version = ?
        AND refresh_dispatched_at IS NOT NULL
    `).bind(now, now, whoopUserId, leaseId, credentialVersion).run();
    return changedRows(result) === 1;
  }
}

export const withWhoopAccessToken = <T>(
  repository: WhoopRepository,
  whoopUserId: number,
  request: AccessTokenRequest<T>,
  refresh: RefreshTokenRequest,
  options: AccessTokenOptions = {},
): Promise<T> => repository.withWhoopAccessToken(whoopUserId, request, refresh, options);
