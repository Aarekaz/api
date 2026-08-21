# WHOOP Health Source API Design

**Status:** Approved in chat on 2026-08-19; written-spec review pending

**Companion:** `os/docs/superpowers/specs/2026-08-19-whoop-health-source-design.md`

## Goal

Make WHOOP the sole ongoing source of wearable health data for the personal API while preserving existing Apple Health records as read-only history. Store every record and field exposed by the public WHOOP Developer API v2, sync it reliably, and expose typed read models to `anurag.os`.

The user confirmed that they own the imported WHOOP data and have permission to retain it. This design does not claim access to data WHOOP does not expose through its public API.

## Product Decisions

- WHOOP is the only ongoing wearable ingestion source after cutover.
- Existing `apple_health_*` rows remain intact and queryable as historical data.
- Apple Shortcut ingestion is retired after WHOOP backfill and live synchronization are verified.
- WHOOP source records use provider-native tables. They are not forced into Apple Health's calendar-day schema.
- The API supplies a derived, stable health read model for OS; OS does not interpret raw WHOOP payloads.
- Imported WHOOP data is read-only. The public WHOOP API exposes read scopes, not workout or sleep mutations.
- Custom workout planning and logging under `/v1/custom/*` remain independent.
- The first release supports one connected WHOOP account, matching this personal API's single-owner architecture. Tables retain `whoop_user_id` so this constraint can be lifted without rewriting source records.

## Verified WHOOP Constraints

- Use Developer API v2. Activity IDs are UUIDs; cycle IDs remain integers.
- Required scopes are `offline`, `read:profile`, `read:body_measurement`, `read:cycles`, `read:recovery`, `read:sleep`, and `read:workout`.
- Access tokens are short-lived. Refreshing rotates both the access and refresh tokens and invalidates the previous pair.
- Collection endpoints return at most 25 records per page and paginate with `next_token`/`nextToken`.
- Default limits are 100 requests per minute and 10,000 requests per day.
- V2 webhooks cover workout, sleep, and recovery updates/deletions. They can be duplicated and have no documented ordering guarantee.
- Cycle, profile, and body-measurement changes have no documented webhook events and require reconciliation.
- Recovery webhook IDs are associated sleep UUIDs, not cycle IDs.
- WHOOP retries failed webhook deliveries five times over roughly one hour and recommends a successful response within one second.
- The public API does not expose continuous heart-rate samples, raw sensor data, steps, VO2 Max, Stress Monitor, Healthspan, WHOOP Age, Pace of Aging, or device-specific Peak fields.

## System Shape

```text
WHOOP OAuth callback ─┐
WHOOP signed webhook ─┼─> API integration routes ─> Cloudflare Queue ─> WHOOP sync consumer
Scheduled reconcile ──┘                                      │
                                                            v
                                                    WHOOP-native D1 tables
                                                            │
                                                            v
                                                 Typed /v1/health/whoop API
                                                            │
                                                            v
                                                        anurag.os

Existing apple_health_* tables ─> read-only legacy endpoints/archive
```

The Cloudflare Worker remains the integration owner. OS initiates connection through protected API calls but never receives the WHOOP client secret, access token, or refresh token.

## Configuration and Secrets

Add server-side configuration:

- `WHOOP_CLIENT_ID`: Worker secret because WHOOP's terms classify developer credentials as confidential.
- `WHOOP_CLIENT_SECRET`: Worker secret used for token exchange and webhook HMAC verification.
- `WHOOP_TOKEN_ENCRYPTION_KEY`: 32-byte random Worker secret, encoded for import into Web Crypto AES-256-GCM.
- `WHOOP_REDIRECT_URI`: exact registered callback, normally `https://api.anuragd.me/integrations/whoop/callback`.
- `OS_BASE_URL`: fixed post-OAuth redirect origin. It must not be accepted from a request parameter.
- `WHOOP_SYNC_QUEUE`: queue producer binding.

Add queue configuration for `whoop-health-sync` and a `whoop-health-sync-dlq`. The API Worker is both producer and consumer. Start with a small batch size, a retry delay, and a single consumer concurrency because WHOOP refresh tokens rotate and concurrent refreshes race.

## Storage Design

Migration `0020_whoop.sql` creates the following tables. Every source table includes `raw_json` so fields added by WHOOP are retained before the typed model is updated.

### `whoop_connections`

One row per WHOOP user. Columns:

- `whoop_user_id` primary key
- `status`: `connecting`, `backfilling`, `active`, `needs_reauth`, `disconnected`, or `error`
- encrypted access token ciphertext, nonce, and expiry
- encrypted refresh token ciphertext and nonce
- granted scopes
- refresh lease ID and expiry used to serialize token rotation
- connection, refresh, last-success, last-error, and disconnection timestamps
- sanitized last error and consecutive failure count

AES-GCM additional authenticated data binds ciphertext to the WHOOP user ID and token kind. Token values are never logged, returned, or included in exports.

### `whoop_oauth_states`

Short-lived, one-use OAuth state records:

- SHA-256 state hash as the primary key
- creation and expiry timestamps
- consumed timestamp

WHOOP requires manually generated state to be exactly eight characters. Generate eight random URL-safe alphanumeric characters with unbiased rejection sampling, store only its SHA-256 hash, and never log the plaintext. Callback consumption is atomic and rejects missing, expired, or reused state.

### Source tables

- `whoop_profiles`: user ID, name, email, upstream timestamps when present, `raw_json`, `synced_at`
- `whoop_body_measurements`: user ID, height, weight, max HR, `raw_json`, `synced_at`
- `whoop_cycles`: integer cycle ID, user ID, time bounds, timezone offset, score state, strain, kilojoules, average/max HR, upstream timestamps, `raw_json`, deletion/sync timestamps
- `whoop_recoveries`: sleep UUID primary key, cycle ID, user ID, score state, calibration flag, recovery score, RHR, HRV, SpO2, skin temperature, upstream timestamps, `raw_json`, deletion/sync timestamps
- `whoop_sleeps`: sleep UUID, cycle/user IDs, time bounds, timezone, nap flag, score state, all approved stage durations including in-bed/no-data, baseline/debt/recent-strain/recent-nap sleep need, cycle/disturbance counts, respiratory rate, performance/consistency/efficiency, upstream timestamps, `raw_json`, deletion/sync timestamps
- `whoop_workouts`: workout UUID, user ID, time bounds, timezone, sport ID/name, score state, strain, HR, kilojoules, percent recorded, distance/elevation, all six HR-zone durations, upstream timestamps, `raw_json`, deletion/sync timestamps

Provider IDs are stable upsert keys. An update is accepted when its upstream `updated_at` is newer than or equal to the stored value. Equal timestamps remain safe because upserts are deterministic.

### Synchronization tables

- `whoop_webhook_events`: `trace_id` primary key, user ID, resource ID, event type, received/processed timestamps, status, attempts, sanitized error
- `whoop_sync_checkpoints`: user ID plus resource primary key, mode, window, next token, status, page/record counts, timestamps, sanitized error
- `whoop_sync_runs`: run ID, user/lifecycle/generation, trigger, exact target/completion counts, derived page/record counters, queued/running/retrying/complete/error status, start/success/error timestamps, sanitized error

Deletion webhooks idempotently mark source rows with `deleted_at`; they do not hard-delete immediately. Because WHOOP deletion envelopes carry no source-update timestamp, a tombstone blocks webhook-driven resurrection until scheduled authoritative reconciliation confirms a current upstream record. Read endpoints exclude tombstones by default.

## OAuth Flow

1. OS calls protected `POST /v1/integrations/whoop/connect`.
2. API verifies configuration, creates an OAuth state record, and returns a WHOOP authorization URL using the fixed redirect URI and exact scopes.
3. The browser navigates to WHOOP. WHOOP redirects to public `GET /integrations/whoop/callback`.
4. API atomically consumes state before exchanging the code.
5. API exchanges the authorization code server-side, fetches the basic profile, encrypts both tokens, and upserts the connection.
6. API queues initial profile, body, cycle, recovery, sleep, and workout synchronization and redirects only to fixed `OS_BASE_URL` with a non-sensitive result code.

WHOOP's public documentation does not state PKCE support. Do not send PKCE parameters unless live validation or updated official documentation confirms support.

Refresh uses a single function with a D1 lease stored on `whoop_connections`. A conditional update acquires a random lease ID only when the prior lease is absent or expired. The lease owner re-reads the current encrypted token immediately before refresh and stores the rotated pair while clearing its lease. A non-owner waits briefly, re-reads the newly stored token once, and never submits the old refresh token concurrently. An abandoned lease expires after 30 seconds. The original WHOOP request is retried once; a second 401 marks `needs_reauth` rather than looping.

## Backfill and Reconciliation

Initial backfill requests each collection without a minimum start date, `limit=25`, and follows every `next_token`. WHOOP documents no historical retention guarantee, so successful exhaustion—not a promised lookback—is the completion condition.

Each queue message processes one resource page and enqueues the next cursor. Checkpoints make the process resumable. Requests inspect `X-RateLimit-*`; a 429 or transient 5xx retries after the documented reset/retry delay. Permanent 4xx responses fail the resource checkpoint without retry storms.

Scheduled synchronization performs:

- token refresh before expiry
- recent-window reconciliation for cycles, recoveries, sleeps, and workouts using a 14-day overlapping window
- daily profile and body-measurement refresh
- recovery reconciliation for pending/unscorable records that may later become scored

Manual protected `POST /v1/integrations/whoop/sync` queues the same idempotent reconciliation; it does not perform upstream work inside the request.

Reconciliation creates its lifecycle-fenced run before queue publication. Run counters and state are recomputed from durable per-target checkpoints rather than incremented, so redelivery cannot double-count progress. Durable reconciliation and webhook success/failure also updates sanitized connection health only when the exact `connection_id` remains current.

An independent scheduled retention job performs bounded deletes. It removes expired/consumed OAuth states, abandoned seen rows, and nonterminal checkpoint/run rows proven superseded by connection lifecycle or reconciliation generation after one day. Superseded terminal checkpoints/runs and processed update-webhook receipts are removed after 30 days. Current nonterminal work, nonterminal webhook receipts, and every deletion-webhook receipt are retained; the latest useful progress is preserved.

## Webhook Flow

Public `POST /integrations/whoop/webhook` reads the unmodified raw request body and:

1. Requires `X-WHOOP-Signature` and `X-WHOOP-Signature-Timestamp`.
2. Rejects stale timestamps outside a five-minute replay window.
3. Verifies `base64(HMAC-SHA256(timestamp + rawBody, client_secret))` with Web Crypto.
4. Validates the v2 payload and connected WHOOP user.
5. Inserts `trace_id` idempotently and publishes the event to `WHOOP_SYNC_QUEUE`.
6. Returns 204 within one second. A duplicate valid trace also returns 204.

The consumer fetches authoritative current data rather than trusting webhook payloads. For `recovery.updated`, it fetches the sleep UUID first to obtain `cycle_id`, then fetches that cycle's recovery. Delete events write tombstones directly from their stable resource identifiers. Scheduled reconciliation repairs missed, late, or out-of-order delivery.

## API Surface

Integration management:

- `GET /v1/integrations/whoop` — connection, scopes, backfill progress, and health; never tokens
- `POST /v1/integrations/whoop/connect` — authorization URL
- `POST /v1/integrations/whoop/sync` — enqueue reconciliation
- `DELETE /v1/integrations/whoop` — revoke WHOOP access and stop synchronization while retaining imported history
- `DELETE /v1/integrations/whoop/data` — separately confirmed local data deletion; rejected while the connection is active

Typed read endpoints:

- `GET /v1/health/whoop/overview`
- `GET /v1/health/whoop/cycles`
- `GET /v1/health/whoop/recoveries`
- `GET /v1/health/whoop/sleeps`
- `GET /v1/health/whoop/workouts`
- `GET /v1/health/whoop/workouts/:workoutId`
- `GET /v1/health/whoop/profile`

Collection endpoints use validated `start`, `end`, `limit`, and opaque local cursor parameters. The workout-detail endpoint returns 404 for a missing or tombstoned UUID. Overview returns `current_cycle`, `current_recovery`, `current_sleep`, recent workouts, 7/30-day trend points, and synchronization status. Normalized score states are `scored`, `pending`, and `unscorable`; recovery calibration is the separate nullable `user_calibrating` flag. Missing or pending values remain `null`, never zero.

Read-model timestamps use `start_at`, `end_at`, `created_at`, and `updated_at`. Native WHOOP duration fields are persisted in milliseconds; API sleep-stage, sleep-need, and heart-rate-zone durations are integer `*_seconds` values derived by dividing by 1,000. HRV is exposed as `hrv_rmssd_milliseconds`. A missing connection row is represented by the non-persisted read state `{ "status": "not_connected" }`.

Energy is stored and returned in WHOOP's source unit, kilojoules. Read models may additionally return `energy_kcal_estimate`, calculated as `kilojoule / 4.184` and explicitly labeled as a derived estimate.

Existing `/v1/health*` Apple endpoints remain unchanged during the first release. They are documented as legacy history after cutover. `/v1/export` adds WHOOP source tables but excludes OAuth states, token ciphertext, webhook signatures, and operational secrets.

## Failure and Privacy Behavior

- Error responses and logs identify operation, resource, status code, and WHOOP trace/request metadata when safe; they never contain tokens, authorization codes, client secrets, webhook signatures, or full PII payloads.
- Upstream 401 triggers one serialized refresh. Repeated 401 requires reconnection.
- Upstream 429 honors the reset header and retries through the queue.
- Upstream 5xx and network failures retry with backoff and eventually enter the DLQ.
- Provider record schemas validate required modeled fields while permitting extension fields, and raw payloads are retained before projection. Records whose core identity/timing fields are invalid are quarantined with sanitized diagnostics rather than silently dropped.
- Disconnect invokes WHOOP's `DELETE /developer/v2/user/access`, clears token ciphertext, and stops new webhook processing. Local deletion is a distinct, explicit action.
- D1 supplies platform encryption at rest and TLS in transit; OAuth token fields additionally use application-level AES-256-GCM.

## Security Prerequisite

Before deployment, rotate the API bearer credential currently present in tracked Apple Shortcut documentation and remove credential material from tracked files. The tracked OS Shortcut signing private key is handled as a separate focused remediation. No credential values may appear in commits, plans, tests, fixtures, or command output.

## Testing

Add focused Vitest coverage for:

- exact OAuth scopes, fixed redirects, state expiry/reuse, and callback failures
- AES-GCM token round trips without value logging
- refresh-token rotation and concurrent refresh serialization
- v2 schema parsing for scored, pending, unscorable, optional, and newly added fields
- pagination exhaustion, cursor persistence, 429 handling, and resume after failure
- signature verification using the raw body, timestamp replay rejection, and `trace_id` deduplication
- update ordering, equal-timestamp idempotency, tombstones, and recovery sleep-ID resolution
- queue acknowledgement/retry behavior and scheduled reconciliation
- authorization boundaries for public callback/webhook versus protected management/read routes
- export secret exclusion

Baseline gates remain TypeScript typecheck and the full Vitest suite. Migration validation uses a fresh local D1 database plus representative v2 fixtures. Production verification uses one authorized WHOOP account, observes backfill counts and queue/DLQ state, edits a test sleep/workout to generate real webhooks, and compares sampled records with the WHOOP app.

## Rollout and Cutover

1. Complete credential remediation.
2. Deploy schema, queue bindings, and integration code without retiring Apple ingestion.
3. Register the exact callback and v2 webhook in WHOOP's dashboard.
4. The user explicitly completes OAuth consent.
5. Run and verify full backfill and live webhook/reconciliation behavior.
6. Release the OS WHOOP experience.
7. Disable Apple Shortcut automation and label Apple endpoints/history as legacy.
8. Monitor sync health and DLQ for at least seven days before considering the migration complete.

Deployment, remote migration, queue creation, secret writes, OAuth consent, and credential rotation are external actions requiring explicit execution authorization at the relevant step.
