# WHOOP Health Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WHOOP the sole ongoing wearable source, preserving Apple Health as immutable legacy history, while exposing secure, typed, provider-native WHOOP records to `anurag.os`.

**Architecture:** The Cloudflare Worker owns OAuth, encrypted token storage, webhook authentication, queue-driven synchronization, and D1 persistence. Provider records remain in WHOOP-native tables keyed by upstream IDs; a separate read-model route derives stable OS responses and excludes tombstones. The existing Apple Health routes remain unchanged until an explicitly authorized cutover after production verification.

**Tech Stack:** TypeScript, Hono, Zod, Cloudflare Workers/D1/Queues/Web Crypto, Vitest, Wrangler.

**Spec:** `docs/superpowers/specs/2026-08-19-whoop-health-source-design.md`

## Global Constraints

- Use WHOOP Developer API v2 only; UUIDs identify sleep/workout records and integer IDs identify cycles.
- Request exactly `offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout`.
- Do not use PKCE unless updated official WHOOP documentation and live validation explicitly authorize it.
- Preserve all existing `/v1/health*` Apple routes and `apple_health_*` rows unchanged in this release.
- WHOOP data is read-only; `/v1/custom/*` continues to own custom workout planning/logging.
- Support exactly one active connection, while retaining `whoop_user_id` on every source table.
- Store source energy in kilojoules. Expose any kcal value only as `energy_kcal_estimate = kilojoules / 4.184`.
- Use `raw_json` on every WHOOP source table; retain upstream fields before the typed model is expanded.
- Never log, return, export, commit, fixture, or print authorization codes, token values, client secrets, webhook signatures, or full PII payloads.
- Encrypt access and refresh tokens with AES-256-GCM using `WHOOP_TOKEN_ENCRYPTION_KEY`; bind ciphertext with `<whoop_user_id>:<token_kind>` additional authenticated data.
- OAuth state is exactly eight URL-safe alphanumeric characters as required by WHOOP, generated without modulo bias, SHA-256 hashed before storage, expires in 10 minutes, and is consumed exactly once.
- Refresh tokens rotate. A D1 lease serializes refreshes; its expiry is 30 seconds and non-owners never submit a token they read before the lease owner completes.
- Initial collection backfill uses `limit=25` and follows every `next_token`; completion means pagination exhaustion, not a promised historical date.
- Queue consumer concurrency is one; webhooks acknowledge valid events within one second and perform upstream work asynchronously.
- Tombstone WHOOP deletions with `deleted_at`; normal read routes exclude tombstones.
- All management and WHOOP read routes require the existing bearer middleware. Only `/integrations/whoop/callback` and `/integrations/whoop/webhook` are public, with callback state and webhook HMAC as their compensating controls.
- Deployment, remote migrations, queue creation, Worker secret writes, credential rotation, WHOOP dashboard configuration, and OAuth consent are external gates; do not perform them in implementation tasks.

---

## File Structure

- `migrations/0020_whoop.sql` — provider-native tables, tombstones, sync state, indexes, and no Apple-table changes.
- `src/types/env.ts` and `wrangler.toml` — typed secret/Queue bindings and local queue configuration only.
- `src/schemas/whoop.ts` — validated WHOOP v2 payloads, route query schemas, OAuth/webhook contracts, and exact public response schemas.
- `src/types/whoop.ts` — provider, queue, and read-model interfaces shared by routes/services.
- `src/services/whoop/crypto.ts` — AES-GCM and one-way state hashing.
- `src/services/whoop/client.ts` — authenticated v2 HTTP client, token exchange/refresh/revoke, pagination, and safe upstream errors.
- `src/services/whoop/repository.ts` — all WHOOP D1 access, idempotent source upserts, state/lease operations, sync state, and export queries.
- `src/services/whoop/sync.ts` — page-by-page source synchronization, recovery resolution, tombstones, rate-limit/retry decisions, and queue message handling.
- `src/routes/whoop-integration.ts` — protected management routes plus public OAuth callback/webhook endpoints.
- `src/routes/whoop-health.ts` — protected typed provider read routes and overview derivation.
- `src/scheduled.ts`, `src/index.ts`, `src/routes/export.ts`, `src/schemas/openapi.ts` — route mounting, scheduled reconciliation, queue dispatch, export and OpenAPI integration.
- `src/__tests__/whoop/*` — fixtures and focused tests; no live WHOOP requests or real credentials.
- `src/__tests__/whoop/fixtures.ts` — redacted v2 records, fixed test environment, fake queue/D1 helpers, bearer request helpers, and local HMAC request construction.
- `docs/WHOOP_HEALTH_SOURCE.md`, `readme.md`, `docs/APPLE_SHORTCUTS.md` — operating contract, legacy Apple status, and credential-safe documentation.

### Task 1: Add the provider schema and Cloudflare bindings

**Files:**
- Create: `migrations/0020_whoop.sql`
- Create: `src/types/whoop.ts`
- Create: `src/schemas/whoop.ts`
- Create: `src/__tests__/whoop/schema.test.ts`
- Create: `src/__tests__/whoop/fixtures.ts`
- Modify: `src/types/env.ts:1-16`
- Modify: `wrangler.toml:5-21`

**Interfaces:**
- Produces `WhoopConnectionStatus`, `WhoopQueueMessage`, `WhoopWebhookEvent`, `WHOOP_SCOPES`, `whoopCollectionQuerySchema`, and `whoopWebhookSchema` for all later tasks.
- Produces `Env.WHOOP_CLIENT_ID`, `Env.WHOOP_CLIENT_SECRET`, `Env.WHOOP_TOKEN_ENCRYPTION_KEY`, `Env.WHOOP_REDIRECT_URI`, `Env.OS_BASE_URL`, and `Env.WHOOP_SYNC_QUEUE: Queue<WhoopQueueMessage>`.

- [ ] **Step 1: Write failing schema tests**

```ts
it("accepts the exact OAuth scopes and rejects an added scope", () => {
  expect(WHOOP_SCOPES).toEqual([
    "offline", "read:profile", "read:body_measurement", "read:cycles",
    "read:recovery", "read:sleep", "read:workout",
  ]);
  expect(whoopWebhookSchema.safeParse({
    user_id: 42,
    id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c",
    type: "sleep.updated",
    trace_id: "7b2dc91e-7423-42b1-a3cb-ecce1a0e2de8",
  }).success).toBe(true);
  expect(whoopWebhookSchema.safeParse({ user_id: 42, id: "x", type: "sleep.created", trace_id: "t" }).success).toBe(false);
});

it("rejects an invalid local cursor and a limit above 100", () => {
  expect(whoopCollectionQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  expect(whoopCollectionQuerySchema.safeParse({ cursor: "not-base64!" }).success).toBe(false);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm test -- src/__tests__/whoop/schema.test.ts`

Expected: FAIL because `src/schemas/whoop.ts` does not exist.

- [ ] **Step 3: Add the minimal shared contracts and binding declarations**

```ts
export const WHOOP_SCOPES = [
  "offline", "read:profile", "read:body_measurement", "read:cycles",
  "read:recovery", "read:sleep", "read:workout",
] as const;

export type WhoopQueueMessage =
  | { kind: "backfill" | "reconcile"; whoopUserId: number; resource: WhoopResource; nextToken?: string }
  | { kind: "webhook"; traceId: string; whoopUserId: number; resourceId: string; eventType: WhoopWebhookEventType };
```

Use `.strict()` for webhook and local route envelopes. Provider record schemas must validate their required modeled identity/timing fields and use `.passthrough()` so upstream extension fields survive in `raw_json`; quarantine invalid core records with sanitized diagnostics. Define local collection query fields as ISO date-times (`start`, `end`), `limit` integer string 1–100, and URL-safe base64 cursor. Add a `[[queues.producers]]` binding and one `[[queues.consumers]]` entry for `whoop-health-sync`, `dead_letter_queue = "whoop-health-sync-dlq"`, `max_batch_size = 1`, `max_batch_timeout = 1`, `max_concurrency = 1`, and `max_retries = 5`.

Create `0020_whoop.sql` with the eleven tables named in the approved spec: `whoop_connections`, `whoop_oauth_states`, six source tables, `whoop_webhook_events`, `whoop_sync_checkpoints`, and `whoop_sync_runs`. Add source-table primary keys exactly as specified, `deleted_at`, `synced_at`, `raw_json TEXT NOT NULL`, and indexes on user/time plus `deleted_at`. Add `CHECK` constraints for connection status and webhook event type. Do not create a migration with a duplicate `0015` prefix.

Create `fixtures.ts` with only synthetic values and these exported helpers used in later test tasks:

```ts
export const NOW = "2026-08-19T12:00:00.000Z";
export const NOW_MS = String(Date.parse(NOW));
export const NOW_MINUS_SIX_MINUTES_MS = String(Date.parse(NOW) - 6 * 60 * 1000);
export const SLEEP = { id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c", cycle_id: 9, user_id: 42, created_at: NOW, updated_at: NOW };
export const WORKOUT = { id: "a2f0c3df-cdb4-48f8-a39b-221b5d8b7a34", user_id: 42, created_at: NOW, updated_at: NOW };
export const SLEEP_UPDATED = { user_id: 42, id: SLEEP.id, type: "sleep.updated", trace_id: "7b2dc91e-7423-42b1-a3cb-ecce1a0e2de8" };
export const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
export const bearerGet = () => ({ headers: { Authorization: "Bearer test-api-token" } });
export const bearerPost = () => ({ method: "POST", headers: { Authorization: "Bearer test-api-token" } });
export const jsonResponse = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
```

`batchOf(message)` returns `{ messages: [{ body: message, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<WhoopQueueMessage>`. `signedWebhook(payload, timestamp = NOW_MS)` serializes `payload`, computes base64 HMAC-SHA-256 over the original millisecond timestamp header string plus `body` with the synthetic test secret using Web Crypto, and returns a `RequestInit` with exact `X-WHOOP-Signature`, `X-WHOOP-Signature-Timestamp`, and `content-type` headers. `ENV` uses only fixture strings, `API_TOKEN: "test-api-token"`, and `WHOOP_SYNC_QUEUE.send: vi.fn()`.

- [ ] **Step 4: Run schema tests and typecheck**

Run: `npm test -- src/__tests__/whoop/schema.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the self-contained foundation**

```bash
git add migrations/0020_whoop.sql src/types/whoop.ts src/schemas/whoop.ts src/types/env.ts wrangler.toml src/__tests__/whoop/schema.test.ts src/__tests__/whoop/fixtures.ts
git commit -m "feat: add WHOOP schema and bindings"
```

### Task 2: Build secret-safe OAuth state and token encryption primitives

**Files:**
- Create: `src/services/whoop/crypto.ts`
- Create: `src/__tests__/whoop/crypto.test.ts`

**Interfaces:**
- Consumes: `Env.WHOOP_TOKEN_ENCRYPTION_KEY` and `whoop_user_id` from Task 1.
- Produces `hashOAuthState(state: string): Promise<string>`, `createOAuthState(): Promise<string>`, `encryptWhoopToken(keyMaterial: string, whoopUserId: number, kind: "access" | "refresh", plaintext: string): Promise<EncryptedToken>`, and `decryptWhoopToken(...)`.

- [ ] **Step 1: Write failing crypto tests**

```ts
it("round-trips a token only with its matching user and token kind", async () => {
  const encrypted = await encryptWhoopToken(KEY, 42, "refresh", "fixture-refresh-token");
  await expect(decryptWhoopToken(KEY, 42, "refresh", encrypted)).resolves.toBe("fixture-refresh-token");
  await expect(decryptWhoopToken(KEY, 43, "refresh", encrypted)).rejects.toThrow("WHOOP token decryption failed");
});

it("creates high-entropy state and hashes it deterministically", async () => {
  const state = await createOAuthState();
  expect(state).toMatch(/^[A-Za-z0-9]{8}$/);
  expect(await hashOAuthState(state)).toBe(await hashOAuthState(state));
});
```

- [ ] **Step 2: Run the failing crypto tests**

Run: `npm test -- src/__tests__/whoop/crypto.test.ts`

Expected: FAIL because `crypto.ts` does not exist.

- [ ] **Step 3: Implement Web Crypto only**

Use `crypto.getRandomValues`, `crypto.subtle.digest("SHA-256", ...)`, and `crypto.subtle.encrypt/decrypt({ name: "AES-GCM", iv, additionalData })`. Generate state from an alphanumeric alphabet with rejection sampling and return exactly eight characters. Decode the 32-byte base64url key once per operation; reject any other byte length. Base64url encode ciphertext/nonce/hash. Throw the fixed sanitized message `WHOOP token decryption failed`; do not interpolate ciphertext, key, or plaintext.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- src/__tests__/whoop/crypto.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit crypto primitives**

```bash
git add src/services/whoop/crypto.ts src/__tests__/whoop/crypto.test.ts
git commit -m "feat: encrypt WHOOP OAuth tokens"
```

### Task 3: Implement the WHOOP v2 client with one-refresh retry semantics

**Files:**
- Create: `src/services/whoop/client.ts`
- Create: `src/__tests__/whoop/client.test.ts`

**Interfaces:**
- Consumes: `WHOOP_SCOPES`, schemas, and encrypted token records from Tasks 1–2.
- Produces `WhoopClient`, `exchangeAuthorizationCode(code: string)`, `refreshToken(refreshToken: string)`, `revokeAccess(accessToken: string)`, `getProfile()`, `getBodyMeasurements()`, `getCollection(resource, params)`, `getCycle(cycleId)`, `getRecovery(cycleId)`, `getSleep(sleepId)`, and `getWorkout(workoutId)`.

- [ ] **Step 1: Write failing HTTP-boundary tests with mocked `fetch`**

```ts
it("uses v2, sends a bearer token, and preserves WHOOP next_token", async () => {
  fetchMock.mockResolvedValue(jsonResponse({ records: [SLEEP], next_token: "page-2" }));
  const page = await client.getCollection("sleep", { limit: 25 });
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/developer/v2/activity/sleep?limit=25"),
    expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer access" }) }),
  );
  expect(page.nextToken).toBe("page-2");
});

it("turns a 429 into a retryable error using retry-after", async () => {
  fetchMock.mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "30" } }));
  await expect(client.getCollection("workout", { limit: 25 })).rejects.toMatchObject({ retryAfterSeconds: 30, retryable: true });
});
```

- [ ] **Step 2: Run the failing client tests**

Run: `npm test -- src/__tests__/whoop/client.test.ts`

Expected: FAIL because `client.ts` does not exist.

- [ ] **Step 3: Implement the client and sanitized errors**

Use the fixed base URL `https://api.prod.whoop.com`. Emit no request/response bodies in errors. Parse `X-RateLimit-Reset` and `Retry-After`; mark 429 and 500–599 retryable. Make 401 an identifiable `WhoopUnauthorizedError`; lease orchestration belongs to Task 4, not this class. Validate every successful response with the strict Task 1 schemas while retaining its original `JSON.stringify(payload)` as `rawJson`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- src/__tests__/whoop/client.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the client**

```bash
git add src/services/whoop/client.ts src/__tests__/whoop/client.test.ts
git commit -m "feat: add WHOOP v2 client"
```

### Task 4: Add repository operations, ordering, and serialized token refresh

**Files:**
- Create: `src/services/whoop/repository.ts`
- Create: `src/__tests__/whoop/repository.test.ts`

**Interfaces:**
- Consumes: Task 1 table/schema interfaces and Task 2 encryption helpers.
- Produces `WhoopRepository` methods `consumeOAuthState`, `upsertConnection`, `acquireRefreshLease`, `releaseRefreshLease`, `storeRotatedTokens`, `upsertSourceRecord(resource, record, { tombstonePolicy: "preserve" | "reconcile" })`, `tombstoneSourceRecord`, `createSyncRun`, `upsertCheckpoint`, `recordWebhookEvent`, and `markWebhookQueued`, plus `withWhoopAccessToken` for serialized one-refresh request retry.

- [ ] **Step 1: Write failing D1 interaction tests**

```ts
it("does not overwrite a newer source record with an older update", async () => {
  await repository.upsertSourceRecord("workout", { ...WORKOUT, updated_at: "2026-08-19T10:00:00Z" }, { tombstonePolicy: "reconcile" });
  await repository.upsertSourceRecord("workout", { ...WORKOUT, updated_at: "2026-08-19T09:00:00Z", score: { strain: 1 } }, { tombstonePolicy: "reconcile" });
  expect(db.executedSql()).toContain("WHERE excluded.upstream_updated_at >= whoop_workouts.upstream_updated_at");
});

it("preserves a webhook tombstone until authoritative reconciliation", async () => {
  await repository.tombstoneSourceRecord("workout", WORKOUT.id, NOW);
  await repository.upsertSourceRecord("workout", WORKOUT, { tombstonePolicy: "preserve" });
  expect(await repository.getSourceRecord("workout", WORKOUT.id)).toMatchObject({ deleted_at: NOW });
  await repository.upsertSourceRecord("workout", WORKOUT, { tombstonePolicy: "reconcile" });
  expect(await repository.getSourceRecord("workout", WORKOUT.id)).toMatchObject({ deleted_at: null });
});

it("allows only one refresh lease owner", async () => {
  expect(await repository.acquireRefreshLease(42, "lease-a", NOW)).toBe(true);
  expect(await repository.acquireRefreshLease(42, "lease-b", NOW)).toBe(false);
});
```

- [ ] **Step 2: Run the failing repository tests**

Run: `npm test -- src/__tests__/whoop/repository.test.ts`

Expected: FAIL because `repository.ts` does not exist.

- [ ] **Step 3: Implement parameterized D1 operations**

Implement each source upsert with stable provider key and `WHERE excluded.upstream_updated_at >= <table>.upstream_updated_at`; retain deterministic equal-time updates. Webhook deletion tombstones idempotently by provider key because WHOOP supplies no source-update timestamp. `tombstonePolicy: "preserve"` leaves `deleted_at` intact for webhook/backfill writes; only scheduled authoritative reconciliation passes `"reconcile"` and may clear it after the upstream collection confirms the record exists. Consume OAuth state with a conditional `UPDATE ... WHERE consumed_at IS NULL AND expires_at > ?` and require exactly one changed row. Acquire lease with a conditional update requiring null/expired lease; the lease owner re-reads tokens before rotating and clears the lease in the same token update. A non-owner waits briefly and re-reads the connection once without submitting the token it observed before the wait. `withWhoopAccessToken` retries the original request once after serialized refresh and marks `needs_reauth` on a second 401. Return safe status/progress projections that omit every ciphertext, nonce, lease ID, and raw payload; a missing connection returns virtual status `not_connected`.

- [ ] **Step 4: Run repository tests and typecheck**

Run: `npm test -- src/__tests__/whoop/repository.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit persistence behavior**

```bash
git add src/services/whoop/repository.ts src/__tests__/whoop/repository.test.ts
git commit -m "feat: persist WHOOP source records safely"
```

### Task 5: Implement protected OAuth management and public callback routes

**Files:**
- Create: `src/routes/whoop-integration.ts`
- Create: `src/__tests__/whoop/integration-route.test.ts`
- Modify: `src/index.ts:11-169`
- Modify: `src/schemas/openapi.ts:19-183`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces protected `GET|DELETE /v1/integrations/whoop`, `POST /v1/integrations/whoop/connect`, `POST /v1/integrations/whoop/sync`, `DELETE /v1/integrations/whoop/data`, and public `GET /integrations/whoop/callback`.

- [ ] **Step 1: Write failing route tests**

```ts
it("requires bearer auth for connect and returns a fixed-redirect authorization URL", async () => {
  const unauthorized = await app.request("/v1/integrations/whoop/connect", { method: "POST" }, ENV);
  expect(unauthorized.status).toBe(401);
  const authorized = await app.request("/v1/integrations/whoop/connect", bearerPost(), ENV);
  expect((await authorized.json()).authorization_url).toContain(encodeURIComponent(ENV.WHOOP_REDIRECT_URI));
  expect((await authorized.json()).authorization_url).not.toContain("returnTo");
});

it("rejects consumed state before exchanging the authorization code", async () => {
  repository.consumeOAuthState.mockResolvedValue(false);
  const response = await app.request("/integrations/whoop/callback?code=redacted&state=used", {}, ENV);
  expect(response.status).toBe(400);
  expect(client.exchangeAuthorizationCode).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the failing integration-route tests**

Run: `npm test -- src/__tests__/whoop/integration-route.test.ts`

Expected: FAIL because the route module is not mounted.

- [ ] **Step 3: Implement management and callback flow**

`connect` verifies all required bindings, creates/stores hashed state, and returns only `{ authorization_url }`. The callback consumes state before code exchange, gets profile identity, rejects a second active connection, encrypts tokens, queues initial six-resource backfill, and redirects to `${OS_BASE_URL}/health/source?result=connected` only. Callback errors redirect to the same fixed route with `result=failed`; never include code, state, or upstream error text. `sync` only emits reconciliation messages. `DELETE /v1/integrations/whoop` invokes `DELETE /developer/v2/user/access`, clears token fields, and retains source history. `DELETE /data` requires disconnected status and removes local WHOOP source/operational rows only.

- [ ] **Step 4: Run route tests and typecheck**

Run: `npm test -- src/__tests__/whoop/integration-route.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit OAuth route behavior**

```bash
git add src/routes/whoop-integration.ts src/__tests__/whoop/integration-route.test.ts src/index.ts src/schemas/openapi.ts
git commit -m "feat: add WHOOP OAuth management routes"
```

### Task 6: Implement queue-driven backfill and reconciliation

**Files:**
- Create: `src/services/whoop/sync.ts`
- Create: `src/__tests__/whoop/sync.test.ts`
- Modify: `src/index.ts:163-170`

**Interfaces:**
- Consumes: `WhoopQueueMessage`, `WhoopClient`, and `WhoopRepository` from prior tasks.
- Produces `handleWhoopQueue(batch: MessageBatch<WhoopQueueMessage>, env: Env): Promise<void>` and `enqueueReconciliation(env, whoopUserId, trigger)`.

- [ ] **Step 1: Write failing sync tests**

```ts
it("persists a page, checkpoint, and exactly one next-page message", async () => {
  client.getCollection.mockResolvedValue({ records: [SLEEP], nextToken: "next" });
  await handleWhoopQueue(batchOf({ kind: "backfill", whoopUserId: 42, resource: "sleep" }), ENV);
  expect(repository.upsertSourceRecord).toHaveBeenCalledWith("sleep", SLEEP, { tombstonePolicy: "preserve" });
  expect(ENV.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ nextToken: "next" }));
});

it("resolves recovery.updated through sleep then cycle recovery", async () => {
  await processWebhook({ eventType: "recovery.updated", resourceId: SLEEP.id, whoopUserId: 42 }, deps);
  expect(client.getSleep).toHaveBeenCalledWith(SLEEP.id);
  expect(client.getRecovery).toHaveBeenCalledWith(SLEEP.cycle_id);
});
```

- [ ] **Step 2: Run the failing sync tests**

Run: `npm test -- src/__tests__/whoop/sync.test.ts`

Expected: FAIL because `sync.ts` does not exist.

- [ ] **Step 3: Implement idempotent queue processing**

For backfill, request each page with `limit: 25`, upsert records using `{ tombstonePolicy: "preserve" }`, checkpoint page/record counters, and enqueue only the returned cursor. For scheduled reconciliation, queue 14-day overlapping collections, daily profile/body reads, and pending/unscorable recovery retries, and use `{ tombstonePolicy: "reconcile" }` for authoritative collection results. On retryable upstream error, checkpoint sanitized status and call `message.retry({ delaySeconds })`; permanent 4xx marks the resource run error without looping. A queue message acknowledges only after source write/checkpoint succeeds. Webhook update messages fetch authoritative source data and upsert with `"preserve"`; delete messages tombstone locally without a fetch.

- [ ] **Step 4: Run sync tests and typecheck**

Run: `npm test -- src/__tests__/whoop/sync.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit sync engine**

```bash
git add src/services/whoop/sync.ts src/__tests__/whoop/sync.test.ts src/index.ts
git commit -m "feat: synchronize WHOOP records through queues"
```

### Task 7: Add signed public webhook ingestion and scheduled reconciliation

**Files:**
- Create: `src/__tests__/whoop/webhook.test.ts`
- Modify: `src/routes/whoop-integration.ts`
- Modify: `src/scheduled.ts:13-178`
- Modify: `src/__tests__/scheduled.test.ts`

**Interfaces:**
- Consumes: queue/sync services from Task 6.
- Produces public `POST /integrations/whoop/webhook` and scheduled `whoop` refresh-health job.

- [ ] **Step 1: Write failing raw-body signature and schedule tests**

```ts
it("accepts one signed event and acknowledges a duplicate trace", async () => {
  const first = await app.request("/integrations/whoop/webhook", signedWebhook(SLEEP_UPDATED), ENV);
  const duplicate = await app.request("/integrations/whoop/webhook", signedWebhook(SLEEP_UPDATED), ENV);
  expect(first.status).toBe(204);
  expect(duplicate.status).toBe(204);
  expect(ENV.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledTimes(1);
});

it("rejects a timestamp older than five minutes before inserting an event", async () => {
  const response = await app.request("/integrations/whoop/webhook", signedWebhook(SLEEP_UPDATED, NOW_MINUS_SIX_MINUTES_MS), ENV);
  expect(response.status).toBe(401);
  expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
});

it("replays a durable initial backfill intent after ambiguous queue publication", async () => {
  repository.getPendingInitialBackfills.mockResolvedValue([{ whoopUserId: 42, connectionId: "connection-3", credentialVersion: 3 }]);
  await handleScheduled(SCHEDULED_EVENT, ENV);
  expect(ENV.WHOOP_SYNC_QUEUE.sendBatch).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ body: expect.objectContaining({ kind: "backfill", whoopUserId: 42, connectionId: "connection-3" }) })]),
  );
  expect(repository.markInitialBackfillQueued).toHaveBeenCalledWith(42, "connection-3", 3, expect.any(String));
});
```

- [ ] **Step 2: Run failing webhook/scheduled tests**

Run: `npm test -- src/__tests__/whoop/webhook.test.ts src/__tests__/scheduled.test.ts`

Expected: FAIL because the public webhook and `whoop` scheduled job do not exist.

- [ ] **Step 3: Implement the security boundary and cron behavior**

Read `await c.req.raw.text()` exactly once. Require the timestamp header to be a finite integer number of milliseconds since epoch, reject values more than 300,000ms in the past or future, and compute `base64(HMAC-SHA-256(originalTimestampHeader + rawBody, WHOOP_CLIENT_SECRET))`. Compare decoded byte arrays with a constant-time padded XOR loop and accept only `difference === 0`. Require both headers, validate the strict v2 envelope, and load the matching current active/backfilling connection. Persist `connection_id` with the webhook event, include it in the queue message, and require it in `recordWebhookEvent`/`markWebhookQueued`, so a disconnect or reconnect between validation and persistence turns into a safe stale result. Atomically insert a trace with status `received`; send the queue message and mark it `queued` before returning `204`. A duplicate already marked `queued` for that connection returns `204`; a duplicate still in `received` retries queue publication so a transient Queue failure cannot permanently suppress the event. A trace from an old connection lifecycle must never be republished under a new one. Mount this public route outside `/v1/*`; do not add it to bearer skip paths.

In `handleScheduled`, first replay every durable `initial_backfill_pending` intent through one six-message `sendBatch`, carrying its exact `connectionId`; clear the flag with `markInitialBackfillQueued(whoopUserId, connectionId, credentialVersion, ...)` only after confirmed publication. Ambiguous publication leaves the flag set, so the next schedule safely sends duplicate idempotent backfill work rather than losing history. Then call the canonical Task 6 `enqueueReconciliation(env, whoopUserId, "scheduled")` for active connections; it alone begins the monotonic reconciliation generation and publishes `connectionId`/`reconcileRunId`/generation-fenced messages. Run the work through existing `runRefreshJob(env, "whoop", ...)`; preserve the independent `Promise.allSettled` behavior of other jobs. Refresh-before-expiry follows the Task 4 lease flow.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- src/__tests__/whoop/webhook.test.ts src/__tests__/scheduled.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit webhook and scheduler integration**

```bash
git add src/routes/whoop-integration.ts src/scheduled.ts src/__tests__/whoop/webhook.test.ts src/__tests__/scheduled.test.ts
git commit -m "feat: process WHOOP webhooks and reconciliation"
```

### Task 8: Expose typed WHOOP health reads without altering Apple endpoints

**Files:**
- Create: `src/routes/whoop-health.ts`
- Create: `src/__tests__/whoop/health-route.test.ts`
- Modify: `src/index.ts`
- Modify: `src/schemas/openapi.ts`

**Interfaces:**
- Consumes: repository read queries and source types.
- Produces `GET /v1/health/whoop/{overview,cycles,recoveries,sleeps,workouts,profile}` and `GET /v1/health/whoop/workouts/:workoutId`.

- [ ] **Step 1: Write failing contract tests**

```ts
it("normalizes pending recovery separately from calibration and excludes tombstones", async () => {
  repository.getWhoopOverview.mockResolvedValue({ currentRecovery: { score_state: "PENDING_SCORE", user_calibrating: true }, recentWorkouts: [] });
  const response = await app.request("/v1/health/whoop/overview", bearerGet(), ENV);
  expect(response.status).toBe(200);
  expect((await response.json()).current_recovery).toMatchObject({ score_state: "pending", user_calibrating: true, score: null });
});

it("labels a derived kcal estimate while retaining kilojoules", async () => {
  const response = await app.request("/v1/health/whoop/workouts?limit=25", bearerGet(), ENV);
  expect((await response.json()).records[0]).toMatchObject({ kilojoules: 418.4, energy_kcal_estimate: 100 });
});
```

- [ ] **Step 2: Run the failing health-route tests**

Run: `npm test -- src/__tests__/whoop/health-route.test.ts`

Expected: FAIL because WHOOP health routes are not mounted.

- [ ] **Step 3: Implement read models and cursor pagination**

Validate `start`, `end`, `limit`, and opaque local cursor. Query only `deleted_at IS NULL`; workout detail returns 404 for a missing/tombstoned UUID. Return `start_at`/`end_at`/`created_at`/`updated_at`, sync state, and `energy_kcal_estimate` where `kilojoules` exists. Convert native duration milliseconds to rounded integer `*_seconds`; expose HRV as `hrv_rmssd_milliseconds`. Never return `raw_json`, token/lease fields, OAuth state, or webhook signatures. `overview` returns `current_cycle`, `current_recovery`, `current_sleep`, recent workouts, seven- and thirty-day trend arrays, and sanitized synchronization health. Normalize upstream `SCORED`, `PENDING_SCORE`, and `UNSCORABLE` to lowercase `scored`, `pending`, and `unscorable`; expose recovery `user_calibrating` separately and use `null`, never zero, for absent scores. Register exact OpenAPI response/query schemas.

- [ ] **Step 4: Run route tests and typecheck**

Run: `npm test -- src/__tests__/whoop/health-route.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit typed read APIs**

```bash
git add src/routes/whoop-health.ts src/__tests__/whoop/health-route.test.ts src/index.ts src/schemas/openapi.ts
git commit -m "feat: expose typed WHOOP health reads"
```

### Task 9: Extend safe export and document the legacy/cutover contract

**Files:**
- Create: `src/__tests__/whoop/export.test.ts`
- Create: `docs/WHOOP_HEALTH_SOURCE.md`
- Modify: `src/routes/export.ts:36-141`
- Modify: `readme.md:236-254`
- Modify: `docs/APPLE_SHORTCUTS.md`

**Interfaces:**
- Consumes: WHOOP source tables from Task 1 and read-only Apple history decision.
- Produces an export that includes source data but excludes all credentials and operational secrets.

- [ ] **Step 1: Write failing export tests**

```ts
it("exports WHOOP source records but not OAuth state, ciphertext, or webhook signatures", async () => {
  const response = await app.request("/v1/export", bearerGet(), ENV);
  const body = await response.json() as Record<string, unknown>;
  expect(body.whoop).toHaveProperty("workouts");
  expect(JSON.stringify(body)).not.toContain("access_token_ciphertext");
  expect(JSON.stringify(body)).not.toContain("whoop_oauth_states");
  expect(JSON.stringify(body)).not.toContain("signature");
});
```

- [ ] **Step 2: Run the failing export test**

Run: `npm test -- src/__tests__/whoop/export.test.ts`

Expected: FAIL because the export has no WHOOP section.

- [ ] **Step 3: Implement export and documentation changes**

Add only profiles, body measurements, cycles, recoveries, sleeps, and workouts to a `whoop` object in `/v1/export`; exclude connections, OAuth states, webhook events, checkpoints, runs, ciphertext, nonce, signature, and error fields. Document all routes, source units, tombstones, unsupported metrics, OAuth ownership, and external rollout gates in `docs/WHOOP_HEALTH_SOURCE.md`. Mark existing Apple endpoints as legacy history in `readme.md` without changing behavior. Replace every literal credential in `APPLE_SHORTCUTS.md` with `${API_TOKEN}` or `YOUR_API_TOKEN`; do not rotate any credential in this task.

- [ ] **Step 4: Run export tests, full suite, and typecheck**

Run: `npm test -- src/__tests__/whoop/export.test.ts && npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit safe export and docs**

```bash
git add src/routes/export.ts src/__tests__/whoop/export.test.ts docs/WHOOP_HEALTH_SOURCE.md readme.md docs/APPLE_SHORTCUTS.md
git commit -m "docs: document WHOOP health source"
```

### Task 10: Validate the migration and run release-level checks

**Files:**
- Create: `src/__tests__/whoop/migration.test.ts`
- Modify: `package.json:6-19`
- Modify: `.github/workflows/ci.yml:24-31`

**Interfaces:**
- Consumes: all preceding modules.
- Produces `npm run test:whoop` and CI coverage of the focused WHOOP suite.

- [ ] **Step 1: Write a failing local-D1 migration test**

```ts
it("creates every WHOOP table and index without changing Apple Health tables", async () => {
  const migrationSql = await readFile("migrations/0020_whoop.sql", "utf8");
  expect(migrationSql).not.toMatch(/ALTER TABLE\s+apple_health_/i);
  await execFileAsync("npx", ["wrangler", "d1", "migrations", "apply", "personal_api", "--local", "--persist-to", tempDir], { cwd: process.cwd() });
  const { stdout } = await execFileAsync("npx", ["wrangler", "d1", "execute", "personal_api", "--local", "--persist-to", tempDir, "--command", "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", "--json"], { cwd: process.cwd() });
  const tables = JSON.parse(stdout)[0].results.map((row: { name: string }) => row.name);
  expect(tables).toEqual(expect.arrayContaining([
    "whoop_connections", "whoop_oauth_states", "whoop_profiles", "whoop_body_measurements",
    "whoop_cycles", "whoop_recoveries", "whoop_sleeps", "whoop_workouts",
    "whoop_webhook_events", "whoop_sync_checkpoints", "whoop_sync_runs",
  ]));
});
```

- [ ] **Step 2: Run the migration test to verify it fails**

Run: `npm test -- src/__tests__/whoop/migration.test.ts`

Expected: FAIL until the local D1 migration harness is present.

- [ ] **Step 3: Add the smallest reproducible migration harness and release commands**

At the top of `migration.test.ts`, import `mkdtemp`/`rm` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`, `readFile` from `node:fs/promises`, and `execFile` from `node:child_process`, then promisify it as `execFileAsync`. Create `tempDir = await mkdtemp(join(tmpdir(), "whoop-d1-"))` in `beforeEach` and remove it with `await rm(tempDir, { recursive: true, force: true })` in `afterEach`. Add `"test:whoop": "vitest run src/__tests__/whoop"` to `package.json`; run it in CI before the existing complete test command. Do not call remote D1, deploy, create queues, write secrets, or invoke OAuth.

- [ ] **Step 4: Run all release-level checks**

Run: `npm run test:whoop && npm test && npm run typecheck`

Expected: PASS with no network requests.

- [ ] **Step 5: Commit verification coverage**

```bash
git add src/__tests__/whoop/migration.test.ts package.json .github/workflows/ci.yml
git commit -m "test: validate WHOOP migration and sync suite"
```

## External rollout gates after implementation

1. Obtain explicit authorization to rotate the leaked API bearer credential and remove it from all tracked history where feasible.
2. Obtain explicit authorization to create Cloudflare queues, write Worker secrets, apply `0020_whoop.sql` remotely, and deploy the Worker.
3. Register the exact `WHOOP_REDIRECT_URI` and v2 webhook URL in WHOOP's Developer Dashboard.
4. The user completes WHOOP OAuth consent; no agent completes it.
5. Observe queue/DLQ counts, full-pagination completion, sampled v2 record parity, a test workout/sleep edit webhook, deletion tombstones, and 14-day reconciliation.
6. Only after those checks and explicit approval, disable Apple Shortcut automation and label Apple ingestion read-only legacy history.

## Self-review

- **Spec coverage:** Tasks 1–4 cover storage, configuration, schemas, encryption, OAuth state, refresh leases, and typed upstream client behavior. Tasks 5–7 cover OAuth, queues, webhook HMAC/replay/deduplication, backfill/reconciliation, deletion, rate limits, and cron. Tasks 8–9 cover typed OS-facing reads, source-unit labeling, legacy Apple preservation, export exclusions, and documentation. Task 10 validates fresh-D1 migration, focused tests, full tests, typecheck, and CI.
- **Type consistency:** All routes consume `WhoopQueueMessage`, `WhoopRepository`, `WhoopClient`, and Task 1 schemas. Provider UUIDs remain strings, cycle IDs remain numbers, and all source energy remains `kilojoules` through storage and reads.
- **Placeholder scan:** This plan contains no `TBD`, `TODO`, “implement later”, or unspecified error-handling steps. External gates are intentionally named actions, not implementation placeholders.
