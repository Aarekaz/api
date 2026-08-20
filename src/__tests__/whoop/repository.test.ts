import { describe, expect, it, vi } from "vitest";
import {
  WhoopClient,
  WhoopRefreshDefiniteError,
  WhoopRequestError,
  WhoopUnauthorizedError,
} from "../../services/whoop/client";
import { encryptWhoopToken } from "../../services/whoop/crypto";
import {
  WhoopRepository,
  withWhoopAccessToken,
} from "../../services/whoop/repository";
import { ENV, jsonResponse, KEY, NOW, WORKOUT } from "./fixtures";

type DbRow = Record<string, unknown>;
type SqlCall = { sql: string; bindings: unknown[] };

const TABLE_KEYS: Record<string, string> = {
  whoop_profiles: "whoop_user_id",
  whoop_body_measurements: "whoop_user_id",
  whoop_cycles: "cycle_id",
  whoop_recoveries: "sleep_id",
  whoop_sleeps: "sleep_id",
  whoop_workouts: "workout_id",
};

class FakeD1 {
  readonly calls: SqlCall[] = [];
  readonly sourceRows = new Map<string, DbRow>();
  readonly connections = new Map<number, DbRow>();
  readonly oauthStates = new Map<string, DbRow>();
  readonly webhookEvents = new Map<string, DbRow>();
  pendingInitialBackfills: DbRow[] = [];
  onLeaseAcquired?: () => void | Promise<void>;
  onStoreRotated?: () => void | Promise<void>;
  onQuarantine?: () => void | Promise<void>;

  prepare(sql: string) {
    return {
      bind: (...bindings: unknown[]) => this.bound(sql, bindings),
      first: <T>() => this.first<T>(sql, []),
      all: <T>() => this.all<T>(sql, []),
      run: () => this.run(sql, []),
    };
  }

  executedSql(): string {
    return this.calls.map(({ sql }) => sql).join("\n");
  }

  sourceRow(table: string, id: string | number): DbRow | undefined {
    return this.sourceRows.get(`${table}:${id}`);
  }

  private bound(sql: string, bindings: unknown[]) {
    return {
      first: <T>() => this.first<T>(sql, bindings),
      all: <T>() => this.all<T>(sql, bindings),
      run: () => this.run(sql, bindings),
    };
  }

  private record(sql: string, bindings: unknown[]) {
    this.calls.push({ sql, bindings });
  }

  private async first<T>(sql: string, bindings: unknown[]): Promise<T | null> {
    this.record(sql, bindings);
    if (sql.includes("FROM whoop_connections")) {
      const row = this.connections.get(Number(bindings[0]));
      if (!row) return null;
      if (sql.includes("refresh_lease_id = ?")) {
        const [, credentialVersion, leaseId, now] = bindings;
        if (!["active", "backfilling"].includes(String(row.status))
          || row.credential_version !== credentialVersion
          || row.refresh_lease_id !== leaseId
          || String(row.refresh_lease_expires_at) <= String(now)) return null;
      }
      return row as T;
    }
    return null;
  }

  private async all<T>(sql: string, bindings: unknown[]) {
    this.record(sql, bindings);
    if (sql.includes("initial_backfill_pending = 1")) {
      return { results: this.pendingInitialBackfills as T[], success: true, meta: {} };
    }
    return { results: [] as T[], success: true, meta: {} };
  }

  private async run(sql: string, bindings: unknown[]) {
    this.record(sql, bindings);
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("UPDATE whoop_oauth_states")) {
      const [consumedAt, stateHash, now] = bindings as [string, string, string];
      const row = this.oauthStates.get(stateHash);
      if (!row || row.consumed_at !== null || String(row.expires_at) <= now) return result(0);
      row.consumed_at = consumedAt;
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET refresh_lease_id = ?")) {
      const [leaseId, expiresAt, whoopUserId, credentialVersion, now] = bindings as [string, string, number, number, string];
      const row = this.connections.get(whoopUserId);
      if (!row || !["active", "backfilling"].includes(String(row.status))
        || row.credential_version !== credentialVersion
        || row.refresh_dispatched_at !== null
        || (row.refresh_lease_id !== null && String(row.refresh_lease_expires_at) > now)) return result(0);
      row.refresh_lease_id = leaseId;
      row.refresh_lease_expires_at = expiresAt;
      await this.onLeaseAcquired?.();
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET refresh_dispatched_at = ?")) {
      const [dispatchedAt, whoopUserId, leaseId, credentialVersion, now] = bindings;
      const row = this.connections.get(Number(whoopUserId));
      if (!row || !["active", "backfilling"].includes(String(row.status))
        || row.refresh_lease_id !== leaseId
        || row.credential_version !== credentialVersion
        || row.refresh_dispatched_at !== null
        || String(row.refresh_lease_expires_at) <= String(now)) return result(0);
      row.refresh_dispatched_at = dispatchedAt;
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET access_token_ciphertext = ?")) {
      const [accessCiphertext, accessNonce, accessExpiresAt, refreshCiphertext, refreshNonce,
        grantedScopes, refreshedAt, updatedAt, whoopUserId, leaseId, credentialVersion] = bindings;
      const row = this.connections.get(Number(whoopUserId));
      await this.onStoreRotated?.();
      if (!row || row.refresh_lease_id !== leaseId || row.credential_version !== credentialVersion
        || row.refresh_dispatched_at === null) return result(0);
      Object.assign(row, {
        access_token_ciphertext: accessCiphertext,
        access_token_nonce: accessNonce,
        access_token_expires_at: accessExpiresAt,
        refresh_token_ciphertext: refreshCiphertext,
        refresh_token_nonce: refreshNonce,
        granted_scopes: grantedScopes,
        refreshed_at: refreshedAt,
        updated_at: updatedAt,
        refresh_lease_id: null,
        refresh_lease_expires_at: null,
        refresh_dispatched_at: null,
        credential_version: Number(credentialVersion) + 1,
      });
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET refresh_dispatched_at = NULL")) {
      const [updatedAt, whoopUserId, leaseId, credentialVersion] = bindings;
      const row = this.connections.get(Number(whoopUserId));
      if (!row || row.refresh_lease_id !== leaseId || row.credential_version !== credentialVersion
        || row.refresh_dispatched_at === null) return result(0);
      Object.assign(row, {
        refresh_dispatched_at: null,
        refresh_lease_id: null,
        refresh_lease_expires_at: null,
        updated_at: updatedAt,
      });
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET refresh_lease_id = NULL")) {
      const [updatedAt, whoopUserId, leaseId, credentialVersion] = bindings;
      const row = this.connections.get(Number(whoopUserId));
      if (!row || row.refresh_lease_id !== leaseId || row.credential_version !== credentialVersion
        || row.refresh_dispatched_at !== null) return result(0);
      row.refresh_lease_id = null;
      row.refresh_lease_expires_at = null;
      row.updated_at = updatedAt;
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET status = 'needs_reauth'")
      && normalized.includes("refresh_lease_id = NULL")) {
      const [lastErrorAt, updatedAt, whoopUserId, leaseId, credentialVersion] = bindings;
      const row = this.connections.get(Number(whoopUserId));
      await this.onQuarantine?.();
      if (!row || row.refresh_lease_id !== leaseId || row.credential_version !== credentialVersion) return result(0);
      Object.assign(row, {
        status: "needs_reauth",
        last_error_at: lastErrorAt,
        updated_at: updatedAt,
        last_error: "WHOOP token refresh outcome is unknown",
        refresh_lease_id: null,
        refresh_lease_expires_at: null,
      });
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET status = 'needs_reauth'")) {
      const [lastErrorAt, updatedAt, whoopUserId, credentialVersion] = bindings;
      const row = this.connections.get(Number(whoopUserId));
      if (!row || row.credential_version !== credentialVersion) return result(0);
      Object.assign(row, { status: "needs_reauth", last_error_at: lastErrorAt, updated_at: updatedAt });
      return result(1);
    }

    if (normalized.startsWith("INSERT INTO whoop_connections")) {
      const [whoopUserId, status, accessCiphertext, accessNonce, accessExpiresAt,
        refreshCiphertext, refreshNonce, grantedScopes, connectedAt, createdAt, updatedAt] = bindings;
      const current = this.connections.get(Number(whoopUserId));
      this.connections.set(Number(whoopUserId), {
        ...current,
        whoop_user_id: whoopUserId,
        status,
        access_token_ciphertext: accessCiphertext,
        access_token_nonce: accessNonce,
        access_token_expires_at: accessExpiresAt,
        refresh_token_ciphertext: refreshCiphertext,
        refresh_token_nonce: refreshNonce,
        granted_scopes: grantedScopes,
        refresh_lease_id: null,
        refresh_lease_expires_at: null,
        refresh_dispatched_at: null,
        connected_at: connectedAt,
        disconnected_at: null,
        last_error: null,
        consecutive_failure_count: 0,
        credential_version: current ? Number(current.credential_version) + 1 : 1,
        created_at: current?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_webhook_events SET status = 'queued'")) {
      const [traceId] = bindings as [string];
      const row = this.webhookEvents.get(traceId);
      if (!row || row.status !== "received") return result(0);
      row.status = "queued";
      return result(1);
    }

    if (normalized.startsWith("INSERT INTO whoop_webhook_events")) {
      const columns = insertColumns(sql);
      const row = Object.fromEntries(columns.map((column, index) => [column, bindings[index]]));
      row.status = "received";
      row.attempts = 0;
      const traceId = String(row.trace_id);
      if (this.webhookEvents.has(traceId)) return result(0);
      this.webhookEvents.set(traceId, row);
      return result(1);
    }

    const tombstoneMatch = normalized.match(/^UPDATE (whoop_\w+) SET deleted_at = \?, synced_at = \? WHERE (\w+) = \?$/);
    if (tombstoneMatch) {
      const [, table, keyColumn] = tombstoneMatch;
      const [deletedAt, syncedAt, id] = bindings;
      const mapKey = `${table}:${id}`;
      const row = this.sourceRows.get(mapKey) ?? { [keyColumn]: id };
      if (!this.sourceRows.has(mapKey)) return result(0);
      Object.assign(row, { deleted_at: deletedAt, synced_at: syncedAt });
      this.sourceRows.set(mapKey, row);
      return result(1);
    }

    const insertMatch = normalized.match(/^INSERT INTO (whoop_\w+) \(/);
    if (insertMatch && TABLE_KEYS[insertMatch[1]]) {
      const table = insertMatch[1];
      const columns = insertColumns(sql);
      let bindingIndex = 0;
      const incoming: DbRow = {};
      for (const column of columns) {
        if (column === "deleted_at" && normalized.includes("SELECT MAX(received_at)")) {
          const [whoopUserId, resourceId, eventType] = bindings.slice(bindingIndex, bindingIndex + 3);
          bindingIndex += 3;
          const deletedAt = [...this.webhookEvents.values()]
            .filter((event) => event.whoop_user_id === whoopUserId
              && event.resource_id === String(resourceId)
              && event.event_type === eventType)
            .map((event) => String(event.received_at))
            .sort()
            .at(-1);
          incoming[column] = deletedAt ?? null;
        } else {
          incoming[column] = bindings[bindingIndex++];
        }
      }
      const mapKey = `${table}:${incoming[TABLE_KEYS[table]]}`;
      const current = this.sourceRows.get(mapKey);
      if (current && String(incoming.upstream_updated_at ?? "") < String(current.upstream_updated_at ?? "")) {
        return result(0);
      }
      if (current && normalized.includes("deleted_at = CASE") && normalized.includes(`${table}.deleted_at`)) {
        incoming.deleted_at = [current.deleted_at, incoming.deleted_at]
          .filter((value): value is string => typeof value === "string")
          .sort()
          .at(-1) ?? null;
      }
      this.sourceRows.set(mapKey, { ...current, ...incoming });
      return result(1);
    }

    return result(1);
  }
}

const result = (changes: number) => ({ success: true, results: [], meta: { changes } });

class ClaimD1 {
  readonly calls: SqlCall[] = [];
  readonly connections = new Map<number, DbRow>();

  prepare(sql: string) {
    return {
      bind: (...bindings: unknown[]) => ({
        first: <T>() => this.claim<T>(sql, bindings),
      }),
    };
  }

  private async claim<T>(sql: string, bindings: unknown[]): Promise<T | null> {
    this.calls.push({ sql, bindings });
    const whoopUserId = Number(bindings[0]);
    const existingDifferentIdentity = [...this.connections.values()].some((connection) =>
      connection.whoop_user_id !== whoopUserId && connection.status !== "disconnected");
    if (existingDifferentIdentity) return null;
    const current = this.connections.get(whoopUserId);
    const credentialVersion = Number(current?.credential_version ?? 0) + 1;
    this.connections.set(whoopUserId, {
      whoop_user_id: whoopUserId,
      status: bindings[1],
      credential_version: credentialVersion,
    });
    return { credential_version: credentialVersion } as T;
  }
}

class CasD1 {
  readonly calls: SqlCall[] = [];
  batchStatements: Array<{ sql: string; bindings: unknown[] }> = [];
  connectionDeleteChanges = 1;

  prepare(sql: string) {
    return {
      bind: (...bindings: unknown[]) => ({
        sql,
        bindings,
        run: async () => {
          this.calls.push({ sql, bindings });
          return result(this.connectionDeleteChanges);
        },
      }),
    };
  }

  async batch(statements: D1PreparedStatement[]) {
    this.batchStatements = statements as unknown as Array<{ sql: string; bindings: unknown[] }>;
    return this.batchStatements.map((statement, index) => result(
      index === this.batchStatements.length - 1 ? this.connectionDeleteChanges : 1,
    ));
  }
}

function insertColumns(sql: string): string[] {
  const match = sql.match(/\(([^)]+)\)\s*VALUES/i);
  if (!match) throw new Error("Test fake could not parse INSERT columns");
  return match[1].split(",").map((column) => column.trim());
}

async function connectionRow(overrides: DbRow = {}): Promise<DbRow> {
  const access = await encryptWhoopToken(KEY, 42, "access", "access-before-refresh");
  const refresh = await encryptWhoopToken(KEY, 42, "refresh", "refresh-before-lease");
  return {
    whoop_user_id: 42,
    status: "active",
    access_token_ciphertext: access.ciphertext,
    access_token_nonce: access.nonce,
    access_token_expires_at: "2026-08-19T13:00:00.000Z",
    refresh_token_ciphertext: refresh.ciphertext,
    refresh_token_nonce: refresh.nonce,
    granted_scopes: "offline read:workout",
    credential_version: 1,
    refresh_lease_id: null,
    refresh_lease_expires_at: null,
    refresh_dispatched_at: null,
    connected_at: NOW,
    refreshed_at: null,
    last_success_at: null,
    last_error_at: null,
    disconnected_at: null,
    last_error: null,
    consecutive_failure_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function reconnectInput(accessPlaintext = "reconnected-access") {
  const accessToken = await encryptWhoopToken(KEY, 42, "access", accessPlaintext);
  const refreshToken = await encryptWhoopToken(KEY, 42, "refresh", "reconnected-refresh");
  return {
    whoopUserId: 42,
    status: "active" as const,
    accessToken,
    accessTokenExpiresAt: "2026-08-19T14:00:00.000Z",
    refreshToken,
    grantedScopes: ["offline", "read:workout"],
    connectedAt: "2026-08-19T12:00:01.000Z",
  };
}

describe("WHOOP repository", () => {
  it("atomically claims one non-disconnected WHOOP identity while allowing that identity to reconnect", async () => {
    const fake = new ClaimD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const first = { ...(await reconnectInput()), initialBackfillPending: true };
    const secondAccess = await encryptWhoopToken(KEY, 43, "access", "other-access");
    const secondRefresh = await encryptWhoopToken(KEY, 43, "refresh", "other-refresh");
    const second = {
      ...first,
      whoopUserId: 43,
      accessToken: secondAccess,
      refreshToken: secondRefresh,
    };

    const claims = await Promise.all([
      repository.claimAndUpsertConnection(first),
      repository.claimAndUpsertConnection(second),
    ]);

    expect(claims).toEqual([1, null]);
    await expect(repository.claimAndUpsertConnection(first)).resolves.toBe(2);
    expect(fake.connections.size).toBe(1);
    expect(fake.calls[0].sql).toContain("INSERT INTO whoop_connections");
    expect(fake.calls[0].sql).toContain("WHERE NOT EXISTS");
    expect(fake.calls[0].sql).toContain("status != 'disconnected'");
  });

  it("projects durable initial-backfill intent for future queue or scheduler replay", async () => {
    const fake = new FakeD1();
    fake.pendingInitialBackfills = [{ whoop_user_id: 42, credential_version: 3 }];
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.getPendingInitialBackfills()).resolves.toEqual([
      { whoopUserId: 42, credentialVersion: 3 },
    ]);
    expect(fake.calls[0].sql).toContain("initial_backfill_pending = 1");
    expect(fake.calls[0].sql).toContain("status = 'backfilling'");
  });

  it("uses observed credential generation to fence disconnect and every atomic local-data delete", async () => {
    const fake = new CasD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.disconnect(42, 3, NOW)).resolves.toBe(true);
    await expect(repository.deleteLocalData(42, 3)).resolves.toBe(true);

    expect(fake.calls[0].sql).toContain("credential_version = ?");
    expect(fake.calls[0].bindings).toEqual([NOW, NOW, 42, 3]);
    expect(fake.batchStatements).toHaveLength(11);
    for (const statement of fake.batchStatements) {
      expect(statement.sql).toContain("credential_version = ?");
      expect(statement.sql).toContain("status = 'disconnected'");
    }
  });

  it("returns false when the atomic local-data delete loses its disconnected generation", async () => {
    const fake = new CasD1();
    fake.connectionDeleteChanges = 0;
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.deleteLocalData(42, 3)).resolves.toBe(false);
  });

  it("conditionally consumes each unexpired OAuth state only once", async () => {
    const fake = new FakeD1();
    fake.oauthStates.set("state-hash", { consumed_at: null, expires_at: "2026-08-19T12:05:00.000Z" });
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.consumeOAuthState("state-hash", NOW)).resolves.toBe(true);
    await expect(repository.consumeOAuthState("state-hash", NOW)).resolves.toBe(false);

    expect(fake.executedSql()).toContain("consumed_at IS NULL AND expires_at > ?");
    expect(fake.calls[0].bindings).toEqual([NOW, "state-hash", NOW]);
  });

  it("canonicalizes OAuth consumption once for both storage and expiry comparison", async () => {
    const fake = new FakeD1();
    fake.oauthStates.set("offset-state", {
      consumed_at: null,
      expires_at: "2026-08-19T12:00:00.500Z",
    });
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.consumeOAuthState(
      "offset-state",
      "2026-08-19T08:00:00.25-04:00",
    )).resolves.toBe(true);

    expect(fake.oauthStates.get("offset-state")?.consumed_at).toBe("2026-08-19T12:00:00.250Z");
    expect(fake.calls[0].bindings).toEqual([
      "2026-08-19T12:00:00.250Z",
      "offset-state",
      "2026-08-19T12:00:00.250Z",
    ]);
  });

  it("does not overwrite a newer source record with an older update", async () => {
    const fake = new FakeD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await repository.upsertSourceRecord("workout", {
      ...WORKOUT,
      updated_at: "2026-08-19T10:00:00.000Z",
    }, { tombstonePolicy: "reconcile" });
    await repository.upsertSourceRecord("workout", {
      ...WORKOUT,
      updated_at: "2026-08-19T09:00:00.000Z",
      score: { strain: 1 },
    }, { tombstonePolicy: "reconcile" });

    expect(fake.executedSql()).toContain("WHERE excluded.upstream_updated_at >= whoop_workouts.upstream_updated_at");
    expect(fake.sourceRow("whoop_workouts", WORKOUT.id)?.upstream_updated_at)
      .toBe("2026-08-19T10:00:00.000Z");
  });

  it("canonicalizes equal upstream instants before deterministic ordering", async () => {
    const fake = new FakeD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await repository.upsertSourceRecord("workout", {
      ...WORKOUT,
      created_at: "2026-08-19T06:00:00-04:00",
      updated_at: "2026-08-19T10:00:00Z",
      score: { strain: 1 },
    }, { tombstonePolicy: "reconcile" });
    await repository.upsertSourceRecord("workout", {
      ...WORKOUT,
      created_at: "2026-08-19T10:00:00.0000Z",
      updated_at: "2026-08-19T06:00:00.000-04:00",
      score: { strain: 2 },
    }, { tombstonePolicy: "reconcile" });

    expect(fake.sourceRow("whoop_workouts", WORKOUT.id)).toMatchObject({
      upstream_created_at: "2026-08-19T10:00:00.000Z",
      upstream_updated_at: "2026-08-19T10:00:00.000Z",
      strain: 2,
    });
  });

  it("does not let an older instant overwrite a newer instant through offset formatting", async () => {
    const fake = new FakeD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await repository.upsertSourceRecord("workout", {
      ...WORKOUT,
      updated_at: "2026-08-19T10:00:00.000Z",
      score: { strain: 5 },
    }, { tombstonePolicy: "reconcile" });
    await repository.upsertSourceRecord("workout", {
      ...WORKOUT,
      updated_at: "2026-08-19T05:30:00-04:00",
      score: { strain: 1 },
    }, { tombstonePolicy: "reconcile" });

    expect(fake.sourceRow("whoop_workouts", WORKOUT.id)).toMatchObject({
      upstream_updated_at: "2026-08-19T10:00:00.000Z",
      strain: 5,
    });
  });

  it("preserves a webhook tombstone until authoritative reconciliation", async () => {
    const fake = new FakeD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await repository.upsertSourceRecord("workout", WORKOUT, { tombstonePolicy: "preserve" });
    await repository.tombstoneSourceRecord("workout", WORKOUT.id, NOW);
    await repository.upsertSourceRecord("workout", WORKOUT, { tombstonePolicy: "preserve" });
    expect(fake.sourceRow("whoop_workouts", WORKOUT.id)).toMatchObject({ deleted_at: NOW });

    await repository.upsertSourceRecord("workout", WORKOUT, { tombstonePolicy: "reconcile" });
    expect(fake.sourceRow("whoop_workouts", WORKOUT.id)).toMatchObject({ deleted_at: null });
  });

  it("uses a durable delete event to tombstone a record first seen after the webhook", async () => {
    const fake = new FakeD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    await repository.recordWebhookEvent({
      traceId: "delete-before-backfill",
      whoopUserId: 42,
      resourceId: WORKOUT.id,
      eventType: "workout.deleted",
      receivedAt: "2026-08-19T08:00:00-04:00",
    });

    await repository.tombstoneSourceRecord("workout", WORKOUT.id, NOW);
    expect(fake.sourceRow("whoop_workouts", WORKOUT.id)).toBeUndefined();

    await repository.upsertSourceRecord("workout", WORKOUT, { tombstonePolicy: "preserve" });
    expect(fake.sourceRow("whoop_workouts", WORKOUT.id)).toMatchObject({
      deleted_at: "2026-08-19T12:00:00.000Z",
    });

    await repository.tombstoneSourceRecord("workout", WORKOUT.id, "2026-08-19T13:00:00Z");
    await repository.upsertSourceRecord("workout", WORKOUT, { tombstonePolicy: "preserve" });
    expect(fake.sourceRow("whoop_workouts", WORKOUT.id)).toMatchObject({
      deleted_at: "2026-08-19T13:00:00.000Z",
    });

    await repository.upsertSourceRecord("workout", WORKOUT, { tombstonePolicy: "reconcile" });
    expect(fake.sourceRow("whoop_workouts", WORKOUT.id)).toMatchObject({ deleted_at: null });
  });

  it("rejects an unknown tombstone policy instead of silently clearing a tombstone", async () => {
    const fake = new FakeD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.upsertSourceRecord("workout", WORKOUT, {
      tombstonePolicy: "unexpected" as "preserve",
    })).rejects.toThrow("Invalid WHOOP tombstone policy");

    expect(fake.calls).toHaveLength(0);
  });

  it("allows only one refresh lease owner and gives the lease exactly 30 seconds", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.acquireRefreshLease(42, "lease-a", NOW, 1)).resolves.toBe(true);
    await expect(repository.acquireRefreshLease(42, "lease-b", NOW, 1)).resolves.toBe(false);

    expect(fake.connections.get(42)).toMatchObject({
      refresh_lease_id: "lease-a",
      refresh_lease_expires_at: "2026-08-19T12:00:30.000Z",
    });
  });

  it("allows an expired lease to be taken over within the same credential generation", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow({
      refresh_lease_id: "expired-owner",
      refresh_lease_expires_at: "2026-08-19T11:59:59.000Z",
    }));
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.acquireRefreshLease(42, "new-owner", NOW, 1)).resolves.toBe(true);
    expect(fake.connections.get(42)).toMatchObject({
      refresh_lease_id: "new-owner",
      credential_version: 1,
    });
  });

  it("canonicalizes lease time once before expiry calculation and comparison", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow({
      refresh_lease_id: "fractional-owner",
      refresh_lease_expires_at: "2026-08-19T12:00:00.200Z",
    }));
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.acquireRefreshLease(
      42,
      "canonical-owner",
      "2026-08-19T08:00:00.25-04:00",
      1,
    )).resolves.toBe(true);

    expect(fake.connections.get(42)).toMatchObject({
      refresh_lease_id: "canonical-owner",
      refresh_lease_expires_at: "2026-08-19T12:00:30.250Z",
    });
    expect(fake.calls[0].bindings).toEqual([
      "canonical-owner",
      "2026-08-19T12:00:30.250Z",
      42,
      1,
      "2026-08-19T12:00:00.250Z",
    ]);
  });

  it("canonicalizes sync-run, checkpoint-window, and checkpoint-audit timestamps", async () => {
    const fake = new FakeD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await repository.createSyncRun({
      runId: "run-1",
      whoopUserId: 42,
      trigger: "manual",
      startedAt: "2026-08-19T08:00:00.25-04:00",
    });
    await repository.upsertCheckpoint({
      whoopUserId: 42,
      resource: "workout",
      mode: "reconcile",
      windowStart: "2026-08-18T08:00:00-04:00",
      windowEnd: "2026-08-19T08:00:00.5-04:00",
      status: "running",
      pageCount: 1,
      recordCount: 25,
      createdAt: "2026-08-19T08:00:00.25-04:00",
      updatedAt: "2026-08-19T08:01:00.1250-04:00",
    });

    expect(fake.calls[0].bindings[3]).toBe("2026-08-19T12:00:00.250Z");
    expect(fake.calls[1].bindings.slice(3, 5)).toEqual([
      "2026-08-18T12:00:00.000Z",
      "2026-08-19T12:00:00.500Z",
    ]);
    expect(fake.calls[1].bindings.slice(9, 11)).toEqual([
      "2026-08-19T12:00:00.250Z",
      "2026-08-19T12:01:00.125Z",
    ]);
  });

  it("deduplicates webhook receipt and only moves received events to queued", async () => {
    const fake = new FakeD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const event = {
      traceId: "trace-1",
      whoopUserId: 42,
      resourceId: WORKOUT.id,
      eventType: "workout.updated" as const,
      receivedAt: NOW,
    };

    await expect(repository.recordWebhookEvent(event)).resolves.toBe(true);
    await expect(repository.recordWebhookEvent(event)).resolves.toBe(false);
    await expect(repository.markWebhookQueued(event.traceId)).resolves.toBe(true);
    await expect(repository.markWebhookQueued(event.traceId)).resolves.toBe(false);
    expect(fake.webhookEvents.get(event.traceId)?.status).toBe("queued");
    const insert = fake.calls.find(({ sql }) => sql.includes("whoop_webhook_events") && sql.includes("INSERT"));
    expect(insert?.sql).toContain("ON CONFLICT(trace_id) DO NOTHING");
    expect(insert?.sql).not.toContain("INSERT OR IGNORE");
  });

  it("returns a virtual missing status and projects no token, nonce, lease, or raw columns", async () => {
    const fake = new FakeD1();
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.getConnectionStatus(42)).resolves.toEqual({ status: "not_connected" });

    const select = fake.calls[0].sql;
    expect(select).not.toMatch(/ciphertext|nonce|refresh_lease|raw_json|SELECT\s+\*/i);
  });

  it("lease owner rereads the refresh token, atomically stores rotation, and retries once", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const refreshAfterLease = await encryptWhoopToken(KEY, 42, "refresh", "refresh-after-lease");
    fake.onLeaseAcquired = () => {
      Object.assign(fake.connections.get(42)!, {
        refresh_token_ciphertext: refreshAfterLease.ciphertext,
        refresh_token_nonce: refreshAfterLease.nonce,
      });
    };
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const request = vi.fn()
      .mockRejectedValueOnce(new WhoopUnauthorizedError("fixture request"))
      .mockResolvedValueOnce("ok");
    const refresh = vi.fn().mockResolvedValue({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      token_type: "bearer",
      scope: "offline read:workout",
    });

    await expect(withWhoopAccessToken(repository, 42, request, refresh, {
      now: () => new Date(NOW),
      leaseId: () => "lease-owner",
      sleep: vi.fn(),
    })).resolves.toBe("ok");

    expect(refresh).toHaveBeenCalledWith("refresh-after-lease", {
      signal: expect.any(AbortSignal),
    });
    expect(request.mock.calls.map(([token]) => token)).toEqual(["access-before-refresh", "rotated-access"]);
    expect(fake.connections.get(42)).toMatchObject({
      refresh_lease_id: null,
      refresh_lease_expires_at: null,
      refresh_dispatched_at: null,
    });
    const dispatch = fake.calls.find(({ sql }) => sql.includes("SET refresh_dispatched_at = ?"));
    expect(dispatch?.bindings).toEqual([NOW, 42, "lease-owner", 1, NOW]);
    const rotation = fake.calls.find(({ sql }) => sql.includes("SET access_token_ciphertext = ?"));
    expect(rotation?.sql).toContain("refresh_dispatched_at = NULL");
    expect(rotation?.sql).toContain("refresh_lease_id = NULL");
    expect(rotation?.sql).toContain("WHERE whoop_user_id = ? AND refresh_lease_id = ? AND credential_version = ?");
    expect(rotation?.bindings.slice(-3)).toEqual([42, "lease-owner", 1]);
    expect(fake.connections.get(42)?.credential_version).toBe(2);
  });

  it("clears its dispatch latch and owned lease after an explicit definite refresh failure", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const request = vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request"));

    const failure = new WhoopRefreshDefiniteError("token refresh", 400);

    await expect(withWhoopAccessToken(repository, 42, request, vi.fn().mockRejectedValue(failure), {
      now: () => new Date(NOW),
      leaseId: () => "lease-owner",
      sleep: vi.fn(),
    })).rejects.toBe(failure);

    expect(fake.connections.get(42)).toMatchObject({
      refresh_lease_id: null,
      refresh_lease_expires_at: null,
      refresh_dispatched_at: null,
      credential_version: 1,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("aborts refresh inside the lease and quarantines an ambiguous token generation", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    let abortedAt: number | undefined;
    let signalRefreshDispatched!: () => void;
    const refreshDispatched = new Promise<void>((resolve) => {
      signalRefreshDispatched = resolve;
    });
    const refresh = vi.fn((_token: string, options?: { signal?: AbortSignal }) => {
      if (!options?.signal) return Promise.reject(new Error("WHOOP refresh signal is required"));
      signalRefreshDispatched();
      return new Promise<never>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => {
          abortedAt = Date.now();
          reject(options.signal!.reason);
        }, { once: true });
      });
    });
    const request = vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request"));

    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const pending = withWhoopAccessToken(repository, 42, request, refresh, {
        leaseId: () => "lease-owner",
        sleep: vi.fn(),
      });
      const outcome = expect(pending).rejects.toThrow("WHOOP token refresh outcome is unknown");

      await refreshDispatched;
      await vi.advanceTimersByTimeAsync(19_999);
      expect(abortedAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await outcome;

      expect(abortedAt).toBe(Date.parse(NOW) + 20_000);
      expect(abortedAt).toBeLessThan(Date.parse(NOW) + 30_000);
      expect(fake.connections.get(42)).toMatchObject({
        status: "needs_reauth",
        credential_version: 1,
        refresh_lease_id: null,
        refresh_lease_expires_at: null,
        refresh_dispatched_at: NOW,
      });

      const secondRefresh = vi.fn();
      await expect(withWhoopAccessToken(
        repository,
        42,
        vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request")),
        secondRefresh,
        { leaseId: () => "must-not-refresh", sleep: vi.fn() },
      )).rejects.toThrow("WHOOP access token refresh is still in progress");
      expect(secondRefresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps explicit 429 refresh failures eligible for another lease", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const retryable = new WhoopRefreshDefiniteError("token refresh", 429, true, 5);

    await expect(withWhoopAccessToken(
      repository,
      42,
      vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request")),
      vi.fn().mockRejectedValue(retryable),
      { now: () => new Date(NOW), leaseId: () => "failed-owner", sleep: vi.fn() },
    )).rejects.toBe(retryable);

    expect(fake.connections.get(42)).toMatchObject({
      status: "active",
      credential_version: 1,
      refresh_lease_id: null,
      refresh_dispatched_at: null,
    });
    await expect(repository.acquireRefreshLease(42, "retry-owner", NOW, 1)).resolves.toBe(true);
  });

  it("quarantines and retains the dispatch latch when rotated-token encryption fails", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const request = vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request"));
    const refresh = vi.fn().mockResolvedValue({
      access_token: Symbol("invalid-token-input") as unknown as string,
      refresh_token: "unused-refresh-value",
      expires_in: 3600,
      token_type: "bearer",
    });

    await expect(withWhoopAccessToken(repository, 42, request, refresh, {
      now: () => new Date(NOW),
      leaseId: () => "lease-owner",
      sleep: vi.fn(),
    })).rejects.toThrow("WHOOP token refresh outcome is unknown");

    expect(fake.connections.get(42)).toMatchObject({
      status: "needs_reauth",
      refresh_lease_id: null,
      refresh_lease_expires_at: null,
      refresh_dispatched_at: NOW,
      credential_version: 1,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not submit refresh after reconnect invalidates the acquired lease", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const reconnect = await reconnectInput();
    fake.onLeaseAcquired = () => repository.upsertConnection(reconnect);
    const request = vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request"));
    const refresh = vi.fn();

    await expect(withWhoopAccessToken(repository, 42, request, refresh, {
      now: () => new Date(NOW),
      leaseId: () => "stale-owner",
      sleep: vi.fn(),
    })).rejects.toThrow("WHOOP refresh lease ownership was lost before refresh");

    expect(refresh).not.toHaveBeenCalled();
    expect(fake.connections.get(42)).toMatchObject({
      status: "active",
      credential_version: 2,
      refresh_lease_id: null,
    });
  });

  it("quarantines and retains the dispatch latch when rotated-token storage throws", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    fake.onStoreRotated = () => {
      throw new Error("fixture D1 write failed");
    };
    const request = vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request"));
    const refresh = vi.fn().mockResolvedValue({
      access_token: "must-not-be-used",
      refresh_token: "must-not-be-stored",
      expires_in: 3600,
      token_type: "bearer",
    });

    await expect(withWhoopAccessToken(repository, 42, request, refresh, {
      now: () => new Date(NOW),
      leaseId: () => "lease-owner",
      sleep: vi.fn(),
    })).rejects.toThrow("WHOOP token refresh outcome is unknown");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(fake.connections.get(42)).toMatchObject({
      status: "needs_reauth",
      credential_version: 1,
      refresh_lease_id: null,
      refresh_dispatched_at: NOW,
    });
  });

  it("does not use rotated credentials and retains the latch after losing store ownership", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    fake.onStoreRotated = () => {
      fake.connections.get(42)!.refresh_lease_id = "takeover-owner";
    };
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const request = vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request"));
    const refresh = vi.fn().mockResolvedValue({
      access_token: "must-not-be-used",
      refresh_token: "must-not-be-stored",
      expires_in: 3600,
      token_type: "bearer",
    });

    await expect(withWhoopAccessToken(repository, 42, request, refresh, {
      now: () => new Date(NOW),
      leaseId: () => "lease-owner",
      sleep: vi.fn(),
    })).rejects.toThrow("WHOOP token refresh outcome is unknown");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(fake.connections.get(42)).toMatchObject({
      status: "active",
      credential_version: 1,
      refresh_lease_id: "takeover-owner",
      refresh_dispatched_at: NOW,
    });
  });

  it("keeps the durable latch when the ambiguous-outcome quarantine write fails", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    fake.onQuarantine = () => {
      throw new Error("fixture quarantine write failed");
    };
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(withWhoopAccessToken(
      repository,
      42,
      vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request")),
      vi.fn().mockRejectedValue(new WhoopRequestError("token refresh")),
      { now: () => new Date(NOW), leaseId: () => "lease-owner", sleep: vi.fn() },
    )).rejects.toThrow("fixture quarantine write failed");

    expect(fake.connections.get(42)).toMatchObject({
      status: "active",
      credential_version: 1,
      refresh_lease_id: "lease-owner",
      refresh_dispatched_at: NOW,
    });
    await expect(repository.acquireRefreshLease(
      42,
      "must-not-take-over",
      "2026-08-19T12:00:31.000Z",
      1,
    )).resolves.toBe(false);
  });

  it("prevents every later refresh attempt while a dispatch latch remains set", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow({
      refresh_lease_id: "expired-owner",
      refresh_lease_expires_at: "2026-08-19T11:59:59.000Z",
      refresh_dispatched_at: "2026-08-19T11:59:30.000Z",
    }));
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const refresh = vi.fn();

    await expect(withWhoopAccessToken(
      repository,
      42,
      vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request")),
      refresh,
      { now: () => new Date(NOW), leaseId: () => "must-not-refresh", sleep: vi.fn() },
    )).rejects.toThrow("WHOOP access token refresh is still in progress");

    expect(refresh).not.toHaveBeenCalled();
    expect(fake.connections.get(42)?.refresh_dispatched_at).toBe("2026-08-19T11:59:30.000Z");
  });

  it("composes the repository deadline signal through the real WHOOP refresh client", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      token_type: "bearer",
    }));
    const client = new WhoopClient(ENV, "unused-access");
    const request = vi.fn()
      .mockRejectedValueOnce(new WhoopUnauthorizedError("fixture request"))
      .mockResolvedValueOnce("ok");

    await expect(withWhoopAccessToken(
      repository,
      42,
      request,
      (token, options) => client.refreshToken(token, options),
      { now: () => new Date(NOW), leaseId: () => "lease-owner", sleep: vi.fn() },
    )).resolves.toBe("ok");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.prod.whoop.com/oauth/oauth2/token",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("non-owner waits, rereads once, and never resubmits its pre-wait access token", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow({
      refresh_lease_id: "other-owner",
      refresh_lease_expires_at: "2026-08-19T12:00:20.000Z",
    }));
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const afterWait = await encryptWhoopToken(KEY, 42, "access", "access-after-wait");
    const sleep = vi.fn().mockImplementation(async () => {
      Object.assign(fake.connections.get(42)!, {
        access_token_ciphertext: afterWait.ciphertext,
        access_token_nonce: afterWait.nonce,
        credential_version: 2,
        refresh_lease_id: null,
        refresh_lease_expires_at: null,
      });
    });
    const request = vi.fn()
      .mockRejectedValueOnce(new WhoopUnauthorizedError("fixture request"))
      .mockResolvedValueOnce("ok");
    const refresh = vi.fn();

    await expect(withWhoopAccessToken(repository, 42, request, refresh, {
      now: () => new Date(NOW),
      leaseId: () => "losing-owner",
      sleep,
    })).resolves.toBe("ok");

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([token]) => token)).toEqual(["access-before-refresh", "access-after-wait"]);
  });

  it("non-owner does not retry when its single reread still contains the pre-wait token", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow({
      refresh_lease_id: "other-owner",
      refresh_lease_expires_at: "2026-08-19T12:00:20.000Z",
    }));
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const request = vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request"));

    await expect(withWhoopAccessToken(repository, 42, request, vi.fn(), {
      now: () => new Date(NOW),
      leaseId: () => "losing-owner",
      sleep: vi.fn(),
    })).rejects.toThrow("WHOOP access token refresh is still in progress");

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("marks the connection needs_reauth after the one retry also returns 401", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const request = vi.fn().mockRejectedValue(new WhoopUnauthorizedError("fixture request"));
    const refresh = vi.fn().mockResolvedValue({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      token_type: "bearer",
    });

    await expect(withWhoopAccessToken(repository, 42, request, refresh, {
      now: () => new Date(NOW),
      leaseId: () => "lease-owner",
      sleep: vi.fn(),
    })).rejects.toBeInstanceOf(WhoopUnauthorizedError);

    expect(request).toHaveBeenCalledTimes(2);
    expect(fake.connections.get(42)?.status).toBe("needs_reauth");
  });

  it("does not let a stale second 401 poison a reconnected credential generation", async () => {
    const fake = new FakeD1();
    fake.connections.set(42, await connectionRow());
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);
    const reconnect = await reconnectInput("new-generation-access");
    let attempts = 0;
    const request = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts === 2) await repository.upsertConnection(reconnect);
      throw new WhoopUnauthorizedError("fixture request");
    });
    const refresh = vi.fn().mockResolvedValue({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      token_type: "bearer",
    });

    await expect(withWhoopAccessToken(repository, 42, request, refresh, {
      now: () => new Date(NOW),
      leaseId: () => "lease-owner",
      sleep: vi.fn(),
    })).rejects.toBeInstanceOf(WhoopUnauthorizedError);

    expect(fake.connections.get(42)).toMatchObject({
      status: "active",
      credential_version: 3,
      refresh_lease_id: null,
    });
  });
});
