# WHOOP Health Source

WHOOP is the sole ongoing wearable source for this API. Existing Apple Health rows remain immutable legacy history; this release does not delete them or change the behavior of the Apple endpoints. Custom workout plans and logs remain independent under `/v1/custom/*`.

## Route contract

All `/v1/*` routes require the existing API bearer token.

### Connection management

- `GET /v1/integrations/whoop` returns connection and synchronization status.
- `POST /v1/integrations/whoop/connect` creates a one-use OAuth state and returns the WHOOP authorization URL.
- `POST /v1/integrations/whoop/sync` requests asynchronous reconciliation.
- `DELETE /v1/integrations/whoop` revokes and disconnects the active WHOOP grant.
- `DELETE /v1/integrations/whoop/data` removes locally stored WHOOP data after disconnect.

The following provider-facing routes are intentionally public because WHOOP cannot send the personal API bearer token:

- `GET /integrations/whoop/callback` validates and consumes the one-use OAuth state before exchanging the authorization code.
- `POST /integrations/whoop/webhook` verifies WHOOP's raw-body HMAC and timestamp before queueing work.

### Health reads

- `GET /v1/health/whoop/overview`
- `GET /v1/health/whoop/profile`
- `GET /v1/health/whoop/cycles`
- `GET /v1/health/whoop/recoveries`
- `GET /v1/health/whoop/sleeps`
- `GET /v1/health/whoop/workouts`
- `GET /v1/health/whoop/workouts/{workoutId}`

Collection routes accept validated `start`, `end`, `limit`, and opaque `cursor` query parameters. Normal health reads exclude tombstones. Missing or pending WHOOP scores remain `null`, never zero. Score state is normalized separately from the recovery calibration flag.

`GET /v1/export` includes explicit projections of the six WHOOP source resources: profiles, body measurements, cycles, recoveries, sleeps, and workouts. It includes `deleted_at` so a personal export preserves source deletion history. It does not export provider payload JSON, OAuth state, connections, token ciphertext/nonces, webhook events/signatures, synchronization checkpoints/runs, or operational errors.

## Source fields and units

The database retains validated WHOOP source records and their upstream/synchronization timestamps. Public DTOs name units explicitly:

- energy: kilojoules (`kilojoules`); `energy_kcal_estimate` is derived as `kilojoules / 4.184`
- heart rate: beats per minute
- HRV: RMSSD milliseconds
- sleep and heart-rate-zone durations: source milliseconds in storage, seconds in typed health responses
- height, distance, and elevation gain: meters
- weight: kilograms
- skin temperature: degrees Celsius
- SpO2, efficiency, consistency, performance, and recorded coverage: percentages
- timestamps: ISO 8601 instants; timezone offsets are retained separately where WHOOP supplies them

WHOOP deletion webhooks write `deleted_at` tombstones instead of hard-deleting source rows. Normal reads exclude these rows. Authoritative reconciliation can confirm a current upstream record without allowing older or unordered webhook delivery to resurrect deleted data.

## Public API limitations

WHOOP Developer API v2 does not expose continuous heart-rate samples, raw sensor data, steps, VO2 max, Stress Monitor, Healthspan, WHOOP Age, Pace of Aging, or device-specific WHOOP Peak fields. These metrics must not be inferred or represented as collected. The API stores the complete provider response internally as `raw_json` for supported resources, but never returns that payload through typed health reads or the personal export.

## OAuth and synchronization ownership

The Worker owns the complete OAuth lifecycle: exact scope request, fixed redirect URI, one-use hashed state, authorization-code exchange, AES-256-GCM token storage, rotating refresh-token handling, and revocation. Tokens and authorization codes must never be logged, returned, exported, committed, or placed in fixtures.

The queue performs initial pagination, webhook fetches, and reconciliation at concurrency one. Webhook bodies are notifications, not trusted source records; the consumer fetches authoritative data from WHOOP. Initial backfill is complete only after every provider page has been exhausted.

## Apple legacy history

The existing `/v1/health*` Apple Health routes and `apple_health_*` rows are preserved unchanged for historical reads. WHOOP is the ongoing wearable source after the production cutover. This document does not authorize new Apple Shortcut ingestion, table deletion, history rewriting, or conversion of Apple rows into WHOOP rows.

## External rollout gates

Local implementation is not a live connection. Production rollout requires separate, explicit authorization for each external change:

1. create the Cloudflare queue and dead-letter queue;
2. apply the D1 migration remotely;
3. set the WHOOP client ID, client secret, token-encryption key, redirect URI, and fixed OS base URL as Worker configuration/secrets;
4. configure the exact callback and webhook URLs in the WHOOP developer dashboard;
5. deploy the Worker and OS releases;
6. rotate the bearer credential previously exposed in Apple Shortcut documentation and update every legitimate client;
7. complete the user-controlled WHOOP OAuth consent;
8. verify backfill completion, webhook delivery, scheduled reconciliation, typed reads, export redaction, and rollback readiness in production.

Do not run remote migrations, create queues, write secrets, rotate credentials, deploy, configure the WHOOP dashboard, or approve OAuth as part of local development or testing.
