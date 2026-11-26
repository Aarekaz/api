// The WHOOP repository's inputs, projections and row shapes (repository.ts
// re-exports the public ones, so imports from "./repository" keep working).

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
import type { WhoopTokenResponse } from "./client";
import type { EncryptedToken } from "./crypto";

export type TombstonePolicy = "preserve" | "reconcile";

export type PersistableProviderRecord<T> = T & { rawJson?: string };
export type ProfileRecord = PersistableProviderRecord<WhoopProfile>;
export type BodyMeasurementRecord = PersistableProviderRecord<WhoopBodyMeasurement> & {
  whoop_user_id?: number;
  user_id?: number;
};

export interface SourceRecordMap {
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

export interface TokenConnectionRow {
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

export interface AccessTokenOptions {
  now?: () => Date;
  leaseId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  expectedConnectionId?: string;
  refreshBeforeExpirationMilliseconds?: number;
}

export type AccessTokenRequest<T> = (accessToken: string, credentialVersion: number) => Promise<T>;
export type RefreshTokenRequest = (
  refreshToken: string,
  options: { signal: AbortSignal },
) => Promise<WhoopTokenResponse>;

export interface SourceDefinition {
  table: string;
  keyColumn: string;
  columns: readonly string[];
  values: (record: SourceRecordMap[WhoopResource], syncedAt: string) => unknown[];
}

export interface WebhookTombstoneLookup {
  whoopUserId: number;
  providerId: string | number;
  eventType: WhoopWebhookEventType;
}

export interface ReconciliationSeenInput {
  whoopUserId: number;
  connectionId: string;
  reconcileGeneration: number;
  reconcileRunId: string;
  resource: "cycle" | "recovery" | "sleep" | "workout";
  providerId: string | number;
  seenAt: string;
}
