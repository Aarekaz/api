import { describe, expect, it, vi } from "vitest";
import { WhoopUnauthorizedError } from "../../services/whoop/client";
import { encryptWhoopToken } from "../../services/whoop/crypto";
import {
  WhoopRepository,
  withWhoopAccessToken,
} from "../../services/whoop/repository";
import { KEY, NOW, WORKOUT } from "./fixtures";

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
  onLeaseAcquired?: () => void;

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
      return (this.connections.get(Number(bindings[0])) ?? null) as T | null;
    }
    return null;
  }

  private async all<T>(sql: string, bindings: unknown[]) {
    this.record(sql, bindings);
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
      const [leaseId, expiresAt, whoopUserId, now] = bindings as [string, string, number, string];
      const row = this.connections.get(whoopUserId);
      if (!row || (row.refresh_lease_id !== null && String(row.refresh_lease_expires_at) > now)) return result(0);
      row.refresh_lease_id = leaseId;
      row.refresh_lease_expires_at = expiresAt;
      this.onLeaseAcquired?.();
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET access_token_ciphertext = ?")) {
      const [accessCiphertext, accessNonce, accessExpiresAt, refreshCiphertext, refreshNonce,
        grantedScopes, refreshedAt, updatedAt, whoopUserId, leaseId] = bindings;
      const row = this.connections.get(Number(whoopUserId));
      if (!row || row.refresh_lease_id !== leaseId) return result(0);
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
      });
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET refresh_lease_id = NULL")) {
      const [updatedAt, whoopUserId, leaseId] = bindings;
      const row = this.connections.get(Number(whoopUserId));
      if (!row || row.refresh_lease_id !== leaseId) return result(0);
      row.refresh_lease_id = null;
      row.refresh_lease_expires_at = null;
      row.updated_at = updatedAt;
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_connections SET status = 'needs_reauth'")) {
      const [lastErrorAt, updatedAt, whoopUserId] = bindings;
      const row = this.connections.get(Number(whoopUserId));
      if (!row) return result(0);
      Object.assign(row, { status: "needs_reauth", last_error_at: lastErrorAt, updated_at: updatedAt });
      return result(1);
    }

    if (normalized.startsWith("UPDATE whoop_webhook_events SET status = 'queued'")) {
      const [traceId] = bindings as [string];
      const row = this.webhookEvents.get(traceId);
      if (!row || row.status !== "received") return result(0);
      row.status = "queued";
      return result(1);
    }

    if (normalized.startsWith("INSERT OR IGNORE INTO whoop_webhook_events")) {
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
      Object.assign(row, { deleted_at: deletedAt, synced_at: syncedAt });
      this.sourceRows.set(mapKey, row);
      return result(1);
    }

    const insertMatch = normalized.match(/^INSERT INTO (whoop_\w+) \(/);
    if (insertMatch && TABLE_KEYS[insertMatch[1]]) {
      const table = insertMatch[1];
      const columns = insertColumns(sql);
      const incoming = Object.fromEntries(columns.map((column, index) => [column, bindings[index]]));
      const mapKey = `${table}:${incoming[TABLE_KEYS[table]]}`;
      const current = this.sourceRows.get(mapKey);
      if (current && String(incoming.upstream_updated_at ?? "") < String(current.upstream_updated_at ?? "")) {
        return result(0);
      }
      if (current && normalized.includes(`deleted_at = ${table}.deleted_at`)) {
        incoming.deleted_at = current.deleted_at;
      }
      this.sourceRows.set(mapKey, { ...current, ...incoming });
      return result(1);
    }

    return result(1);
  }
}

const result = (changes: number) => ({ success: true, results: [], meta: { changes } });

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
    refresh_lease_id: null,
    refresh_lease_expires_at: null,
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

describe("WHOOP repository", () => {
  it("conditionally consumes each unexpired OAuth state only once", async () => {
    const fake = new FakeD1();
    fake.oauthStates.set("state-hash", { consumed_at: null, expires_at: "2026-08-19T12:05:00.000Z" });
    const repository = new WhoopRepository(fake as unknown as D1Database, KEY);

    await expect(repository.consumeOAuthState("state-hash", NOW)).resolves.toBe(true);
    await expect(repository.consumeOAuthState("state-hash", NOW)).resolves.toBe(false);

    expect(fake.executedSql()).toContain("consumed_at IS NULL AND expires_at > ?");
    expect(fake.calls[0].bindings).toEqual([NOW, "state-hash", NOW]);
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

    await expect(repository.acquireRefreshLease(42, "lease-a", NOW)).resolves.toBe(true);
    await expect(repository.acquireRefreshLease(42, "lease-b", NOW)).resolves.toBe(false);

    expect(fake.connections.get(42)).toMatchObject({
      refresh_lease_id: "lease-a",
      refresh_lease_expires_at: "2026-08-19T12:00:30.000Z",
    });
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
    fake.onLeaseAcquired = () => Object.assign(fake.connections.get(42)!, {
      refresh_token_ciphertext: refreshAfterLease.ciphertext,
      refresh_token_nonce: refreshAfterLease.nonce,
    });
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

    expect(refresh).toHaveBeenCalledWith("refresh-after-lease");
    expect(request.mock.calls.map(([token]) => token)).toEqual(["access-before-refresh", "rotated-access"]);
    expect(fake.connections.get(42)).toMatchObject({ refresh_lease_id: null, refresh_lease_expires_at: null });
    const rotation = fake.calls.find(({ sql }) => sql.includes("SET access_token_ciphertext = ?"));
    expect(rotation?.sql).toContain("refresh_lease_id = NULL");
    expect(rotation?.sql).toContain("WHERE whoop_user_id = ? AND refresh_lease_id = ?");
    expect(rotation?.bindings.slice(-2)).toEqual([42, "lease-owner"]);
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
});
