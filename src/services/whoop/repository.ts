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
  status: Exclude<WhoopConnectionStatus, "not_connected">;
  accessToken: EncryptedToken;
  accessTokenExpiresAt: string;
  refreshToken: EncryptedToken;
  grantedScopes: readonly string[];
  connectedAt: string;
  updatedAt?: string;
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
  trigger: string;
  startedAt: string;
}

export interface CheckpointInput {
  whoopUserId: number;
  resource: WhoopResource;
  mode: string;
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
  resourceId: string;
  eventType: WhoopWebhookEventType;
  receivedAt: string;
}

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
}

interface TokenConnectionRow {
  whoop_user_id: number;
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
}

type AccessTokenRequest<T> = (accessToken: string) => Promise<T>;
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
      "stage_rem_milliseconds", "sleep_needed_milliseconds", "sleep_debt_milliseconds",
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
        firstNumber(needed.baseline_milli, needed.sleep_needed_milli),
        firstNumber(needed.need_from_sleep_debt_milli, needed.sleep_debt_milli),
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
        whoop_user_id, status, access_token_ciphertext, access_token_nonce, access_token_expires_at,
        refresh_token_ciphertext, refresh_token_nonce, granted_scopes, credential_version, refresh_lease_id,
        refresh_lease_expires_at, refresh_dispatched_at, connected_at, refreshed_at, last_success_at, last_error_at,
        disconnected_at, last_error, consecutive_failure_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)
      ON CONFLICT(whoop_user_id) DO UPDATE SET
        status = excluded.status,
        access_token_ciphertext = excluded.access_token_ciphertext,
        access_token_nonce = excluded.access_token_nonce,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        refresh_token_nonce = excluded.refresh_token_nonce,
        granted_scopes = excluded.granted_scopes,
        credential_version = whoop_connections.credential_version + 1,
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
    options: { tombstonePolicy: TombstonePolicy; syncedAt?: string },
  ): Promise<void> {
    if (options.tombstonePolicy !== "preserve" && options.tombstonePolicy !== "reconcile") {
      throw new Error("Invalid WHOOP tombstone policy");
    }
    const definition = sourceDefinitions[resource];
    const values = definition.values(
      record as SourceRecordMap[WhoopResource],
      canonicalTimestamp(options.syncedAt ?? new Date().toISOString())!,
    );
    const tombstoneLookup = options.tombstonePolicy === "preserve"
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
        bindings.push(tombstoneLookup.whoopUserId, tombstoneLookup.providerId, tombstoneLookup.eventType);
        return `(SELECT MAX(received_at)
          FROM whoop_webhook_events
          WHERE whoop_user_id = ? AND resource_id = CAST(? AS TEXT) AND event_type = ?)`;
      }
      bindings.push(values[index]);
      return "?";
    });

    await this.db.prepare(`
      INSERT INTO ${definition.table} (${definition.columns.join(", ")})
      VALUES (${valueExpressions.join(", ")})
      ON CONFLICT(${definition.keyColumn}) DO UPDATE SET
        ${updates}
      WHERE excluded.upstream_updated_at >= ${definition.table}.upstream_updated_at
        OR ${definition.table}.upstream_updated_at IS NULL
    `).bind(...bindings).run();
  }

  async tombstoneSourceRecord(
    resource: WhoopResource,
    providerId: string | number,
    deletedAt: string,
  ): Promise<void> {
    const definition = sourceDefinitions[resource];
    const canonicalDeletedAt = canonicalTimestamp(deletedAt)!;
    await this.db.prepare(`
      UPDATE ${definition.table}
      SET deleted_at = ?, synced_at = ?
      WHERE ${definition.keyColumn} = ?
    `).bind(canonicalDeletedAt, canonicalDeletedAt, providerId).run();
  }

  async createSyncRun(input: SyncRunInput): Promise<void> {
    await this.db.prepare(`
      INSERT INTO whoop_sync_runs (
        run_id, whoop_user_id, trigger, status, page_count, record_count,
        started_at, succeeded_at, failed_at, last_error
      ) VALUES (?, ?, ?, 'running', 0, 0, ?, NULL, NULL, NULL)
    `).bind(
      input.runId,
      input.whoopUserId,
      input.trigger,
      canonicalTimestamp(input.startedAt)!,
    ).run();
  }

  async upsertCheckpoint(input: CheckpointInput): Promise<void> {
    await this.db.prepare(`
      INSERT INTO whoop_sync_checkpoints (
        whoop_user_id, resource, mode, window_start, window_end, next_token, status,
        page_count, record_count, created_at, updated_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(whoop_user_id, resource) DO UPDATE SET
        mode = excluded.mode,
        window_start = excluded.window_start,
        window_end = excluded.window_end,
        next_token = excluded.next_token,
        status = excluded.status,
        page_count = excluded.page_count,
        record_count = excluded.record_count,
        updated_at = excluded.updated_at,
        last_error = excluded.last_error
    `).bind(
      input.whoopUserId,
      input.resource,
      input.mode,
      canonicalTimestamp(input.windowStart),
      canonicalTimestamp(input.windowEnd),
      input.nextToken ?? null,
      input.status,
      input.pageCount,
      input.recordCount,
      canonicalTimestamp(input.createdAt)!,
      canonicalTimestamp(input.updatedAt)!,
      sanitizedError(input.lastError),
    ).run();
  }

  async recordWebhookEvent(input: WebhookEventInput): Promise<boolean> {
    const result = await this.db.prepare(`
      INSERT INTO whoop_webhook_events (
        trace_id, whoop_user_id, resource_id, event_type, received_at,
        processed_at, status, attempts, last_error
      ) VALUES (?, ?, ?, ?, ?, NULL, 'received', 0, NULL)
      ON CONFLICT(trace_id) DO NOTHING
    `).bind(
      input.traceId,
      input.whoopUserId,
      input.resourceId,
      input.eventType,
      canonicalTimestamp(input.receivedAt)!,
    ).run();
    return changedRows(result) === 1;
  }

  async markWebhookQueued(traceId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE whoop_webhook_events
      SET status = 'queued'
      WHERE trace_id = ? AND status = 'received'
    `).bind(traceId).run();
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
      SELECT whoop_user_id, status, granted_scopes, connected_at, refreshed_at, last_success_at,
             last_error_at, disconnected_at, last_error, consecutive_failure_count, updated_at
      FROM whoop_connections
      ORDER BY CASE WHEN status = 'disconnected' THEN 1 ELSE 0 END,
               connected_at DESC, whoop_user_id DESC
      LIMIT 1
    `).first<{
      whoop_user_id: number;
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
    if (!row) return null;
    return {
      whoopUserId: row.whoop_user_id,
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

  async disconnect(whoopUserId: number, disconnectedAt: string): Promise<boolean> {
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
      WHERE whoop_user_id = ? AND status != 'disconnected'
    `).bind(timestamp, timestamp, whoopUserId).run();
    return changedRows(result) === 1;
  }

  async deleteLocalData(whoopUserId: number): Promise<void> {
    const statements = [
      "DELETE FROM whoop_profiles WHERE whoop_user_id = ?",
      "DELETE FROM whoop_body_measurements WHERE whoop_user_id = ?",
      "DELETE FROM whoop_cycles WHERE whoop_user_id = ?",
      "DELETE FROM whoop_recoveries WHERE whoop_user_id = ?",
      "DELETE FROM whoop_sleeps WHERE whoop_user_id = ?",
      "DELETE FROM whoop_workouts WHERE whoop_user_id = ?",
      "DELETE FROM whoop_webhook_events WHERE whoop_user_id = ?",
      "DELETE FROM whoop_sync_checkpoints WHERE whoop_user_id = ?",
      "DELETE FROM whoop_sync_runs WHERE whoop_user_id = ?",
      "DELETE FROM whoop_connections WHERE whoop_user_id = ?",
      "DELETE FROM whoop_oauth_states",
    ];
    await this.db.batch(statements.map((sql) => this.db.prepare(sql).bind(...(
      sql === "DELETE FROM whoop_oauth_states" ? [] : [whoopUserId]
    ))));
  }

  async getSyncProgress(whoopUserId: number): Promise<SyncProgressProjection[]> {
    const result = await this.db.prepare(`
      SELECT resource, mode, status, page_count, record_count, updated_at, last_error
      FROM whoop_sync_checkpoints
      WHERE whoop_user_id = ?
      ORDER BY resource ASC
    `).bind(whoopUserId).all<SyncProgressProjection>();
    return result.results.map((row) => ({ ...row, last_error: sanitizedError(row.last_error) }));
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
    const initialCredentialVersion = initial.credential_version;
    const initialAccessToken = await this.decryptToken(initial, "access");

    try {
      return await request(initialAccessToken);
    } catch (error) {
      if (!(error instanceof WhoopUnauthorizedError)) throw error;
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
      retryAccessToken = await this.decryptToken(reread, "access");
      retryCredentialVersion = reread.credential_version;
      if (retryAccessToken === initialAccessToken) {
        throw new Error("WHOOP access token refresh is still in progress");
      }
    }

    try {
      return await request(retryAccessToken);
    } catch (error) {
      if (error instanceof WhoopUnauthorizedError) {
        await this.markNeedsReauth(whoopUserId, retryCredentialVersion, now().toISOString());
      }
      throw error;
    }
  }

  private async requireTokenConnection(whoopUserId: number): Promise<TokenConnectionRow> {
    const row = await this.db.prepare(`
      SELECT whoop_user_id, status, access_token_ciphertext, access_token_nonce,
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
      SELECT whoop_user_id, status, access_token_ciphertext, access_token_nonce,
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
