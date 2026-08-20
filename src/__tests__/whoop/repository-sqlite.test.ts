import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WhoopRepository, type CheckpointInput } from "../../services/whoop/repository";
import { CONNECTION_ID, KEY, NOW, RECOVERY, WORKOUT } from "./fixtures";

type SqliteStatement = {
  all: (...bindings: unknown[]) => unknown[];
  get: (...bindings: unknown[]) => unknown;
  run: (...bindings: unknown[]) => { changes: number | bigint };
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

class SqliteD1Statement {
  constructor(
    private readonly database: SqliteDatabase,
    readonly sql: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, bindings);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null;
  }

  async all<T>() {
    return {
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      success: true,
      meta: {},
    };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor(readonly database: SqliteDatabase) {}

  prepare(sql: string) {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements as unknown as SqliteD1Statement[]) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const checkpoint = (overrides: Partial<CheckpointInput> & {
  syncRunId: string;
  targetId: string;
}): CheckpointInput => ({
  whoopUserId: 42,
  connectionId: CONNECTION_ID,
  resource: "recovery",
  mode: "backfill",
  windowStart: null,
  windowEnd: null,
  nextToken: null,
  status: "running",
  pageCount: 0,
  recordCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  lastError: null,
  ...overrides,
} as CheckpointInput);

const insertSleep = (
  database: SqliteDatabase,
  id: string,
  startAt: string,
) => database.prepare(`
  INSERT INTO whoop_sleeps (
    sleep_id, cycle_id, whoop_user_id, start_at, end_at, timezone_offset, nap,
    score_state, upstream_created_at, upstream_updated_at, deleted_at, synced_at, raw_json
  ) VALUES (?, 9, 42, ?, ?, '-04:00', 0, 'SCORED', ?, ?, NULL, ?, '{}')
`).run(id, startAt, startAt, startAt, startAt, NOW);

describe("WHOOP repository on SQLite", () => {
  let database: SqliteDatabase;
  let d1: SqliteD1;
  let repository: WhoopRepository;

  beforeEach(async () => {
    // @ts-expect-error The Worker typecheck intentionally excludes Node test-runtime declarations.
    const { DatabaseSync } = await import("node:sqlite");
    // @ts-expect-error The Worker typecheck intentionally excludes Node test-runtime declarations.
    const { readFile } = await import("node:fs/promises");
    database = new DatabaseSync(":memory:") as SqliteDatabase;
    database.exec(await readFile("migrations/0020_whoop.sql", "utf8"));
    database.prepare(`
      INSERT INTO whoop_connections (
        whoop_user_id, connection_id, status, granted_scopes,
        initial_backfill_pending, created_at, updated_at
      ) VALUES (?, ?, 'backfilling', '', 1, ?, ?)
    `).run(42, CONNECTION_ID, NOW, NOW);
    d1 = new SqliteD1(database);
    repository = new WhoopRepository(d1 as unknown as D1Database, KEY);
  });

  afterEach(() => database.close());

  it("isolates backfill, reconciliation, and targeted recovery checkpoints", async () => {
    await repository.upsertCheckpoint(checkpoint({
      syncRunId: "initial",
      targetId: "",
      status: "complete",
      pageCount: 3,
      recordCount: 51,
    }));
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: "reconcile-a",
      targetId: "",
      pageCount: 1,
      recordCount: 20,
      updatedAt: "2026-08-19T12:01:00.000Z",
    }));
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: "reconcile-a",
      targetId: "cycle:9",
      status: "retrying",
      updatedAt: "2026-08-19T12:02:00.000Z",
    }));

    const count = database.prepare("SELECT COUNT(*) AS count FROM whoop_sync_checkpoints")
      .get() as { count: number };
    expect(count.count).toBe(3);
    await expect(repository.getSyncProgress(42)).resolves.toEqual([expect.objectContaining({
      resource: "recovery",
      mode: "reconcile",
      status: "running",
      page_count: 1,
      record_count: 20,
    })]);
  });

  it("does not regress a completed checkpoint when an older page or failure is redelivered", async () => {
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: "reconcile-a",
      targetId: "",
      nextToken: null,
      status: "complete",
      pageCount: 3,
      recordCount: 51,
      updatedAt: "2026-08-19T12:03:00.000Z",
    }));
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: "reconcile-a",
      targetId: "",
      nextToken: "older-cursor",
      status: "running",
      pageCount: 2,
      recordCount: 25,
      updatedAt: "2026-08-19T12:04:00.000Z",
    }));
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: "reconcile-a",
      targetId: "",
      nextToken: "older-cursor",
      status: "error",
      pageCount: 2,
      recordCount: 25,
      updatedAt: "2026-08-19T12:05:00.000Z",
      lastError: "safe failure",
    }));

    const stored = database.prepare(`
      SELECT next_token, status, page_count, record_count, last_error
      FROM whoop_sync_checkpoints
    `).get();
    expect(stored).toEqual({
      next_token: null,
      status: "complete",
      page_count: 3,
      record_count: 51,
      last_error: null,
    });
  });

  it("atomically clears publication intent and activates only a complete six-resource backfill", async () => {
    for (const resource of [
      "profile", "body_measurement", "cycle", "recovery", "sleep", "workout",
    ] as const) {
      await repository.upsertCheckpoint(checkpoint({
        resource,
        syncRunId: "initial",
        targetId: "",
        status: "complete",
        pageCount: 1,
        recordCount: 1,
      }));
    }

    const markQueued = repository.markInitialBackfillQueued.bind(repository) as unknown as (
      whoopUserId: number,
      connectionId: string,
      credentialVersion: number,
      queuedAt: string,
    ) => Promise<boolean>;
    await expect(markQueued(42, CONNECTION_ID, 1, NOW)).resolves.toBe(true);

    const connection = database.prepare(`
      SELECT status, initial_backfill_pending FROM whoop_connections WHERE whoop_user_id = 42
    `).get();
    expect(connection).toEqual({ status: "active", initial_backfill_pending: 0 });
  });

  it("tombstones only in-window records absent from a completed reconciliation", async () => {
    insertSleep(database, "00000000-0000-4000-8000-000000000001", "2026-08-18T08:00:00.000Z");
    insertSleep(database, "00000000-0000-4000-8000-000000000002", "2026-08-17T08:00:00.000Z");
    insertSleep(database, "00000000-0000-4000-8000-000000000003", "2026-07-01T08:00:00.000Z");
    const runId = "00000000-0000-4000-8000-000000000099";
    const recordSeen = repository as unknown as {
      recordReconciliationSeen(input: {
        whoopUserId: number;
        connectionId: string;
        reconcileRunId: string;
        resource: "sleep";
        providerId: string;
        seenAt: string;
      }): Promise<boolean>;
      finalizeReconciliation(input: CheckpointInput): Promise<boolean>;
    };

    await recordSeen.recordReconciliationSeen({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileRunId: runId,
      resource: "sleep",
      providerId: "00000000-0000-4000-8000-000000000001",
      seenAt: NOW,
    });
    await expect(recordSeen.finalizeReconciliation(checkpoint({
      mode: "reconcile",
      syncRunId: runId,
      targetId: "",
      resource: "sleep",
      windowStart: "2026-08-05T12:00:00.000Z",
      windowEnd: NOW,
      status: "complete",
      pageCount: 1,
      recordCount: 1,
    }))).resolves.toBe(true);

    const rows = database.prepare(`
      SELECT sleep_id, deleted_at FROM whoop_sleeps ORDER BY sleep_id
    `).all();
    expect(rows).toEqual([
      { sleep_id: "00000000-0000-4000-8000-000000000001", deleted_at: null },
      { sleep_id: "00000000-0000-4000-8000-000000000002", deleted_at: NOW },
      { sleep_id: "00000000-0000-4000-8000-000000000003", deleted_at: null },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM whoop_reconcile_seen").get())
      .toEqual({ count: 0 });
  });

  it("retains seen identifiers across pages and finalizes idempotently", async () => {
    insertSleep(database, "00000000-0000-4000-8000-000000000001", "2026-08-18T08:00:00.000Z");
    insertSleep(database, "00000000-0000-4000-8000-000000000002", "2026-08-17T08:00:00.000Z");
    insertSleep(database, "00000000-0000-4000-8000-000000000003", "2026-08-16T08:00:00.000Z");
    const runId = "00000000-0000-4000-8000-000000000099";
    const reconciliation = repository as unknown as {
      recordReconciliationSeen(input: {
        whoopUserId: number;
        connectionId: string;
        reconcileRunId: string;
        resource: "sleep";
        providerId: string;
        seenAt: string;
      }): Promise<boolean>;
      finalizeReconciliation(input: CheckpointInput): Promise<boolean>;
    };

    await reconciliation.recordReconciliationSeen({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileRunId: runId,
      resource: "sleep",
      providerId: "00000000-0000-4000-8000-000000000001",
      seenAt: NOW,
    });
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: runId,
      targetId: "",
      resource: "sleep",
      windowStart: "2026-08-05T12:00:00.000Z",
      windowEnd: NOW,
      nextToken: "page-2",
      pageCount: 1,
      recordCount: 1,
    }));
    await reconciliation.recordReconciliationSeen({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileRunId: runId,
      resource: "sleep",
      providerId: "00000000-0000-4000-8000-000000000002",
      seenAt: NOW,
    });
    const finalCheckpoint = checkpoint({
      mode: "reconcile",
      syncRunId: runId,
      targetId: "",
      resource: "sleep",
      windowStart: "2026-08-05T12:00:00.000Z",
      windowEnd: NOW,
      status: "complete",
      pageCount: 2,
      recordCount: 2,
    });
    await reconciliation.finalizeReconciliation(finalCheckpoint);
    await reconciliation.recordReconciliationSeen({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileRunId: runId,
      resource: "sleep",
      providerId: "00000000-0000-4000-8000-000000000002",
      seenAt: NOW,
    });
    await expect(reconciliation.finalizeReconciliation(finalCheckpoint)).resolves.toBe(true);

    expect(database.prepare(`
      SELECT sleep_id, deleted_at FROM whoop_sleeps ORDER BY sleep_id
    `).all()).toEqual([
      { sleep_id: "00000000-0000-4000-8000-000000000001", deleted_at: null },
      { sleep_id: "00000000-0000-4000-8000-000000000002", deleted_at: null },
      { sleep_id: "00000000-0000-4000-8000-000000000003", deleted_at: NOW },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM whoop_reconcile_seen").get())
      .toEqual({ count: 0 });
  });

  it("retains seen identifiers and live rows when reconciliation fails before finalization", async () => {
    insertSleep(database, "00000000-0000-4000-8000-000000000001", "2026-08-18T08:00:00.000Z");
    insertSleep(database, "00000000-0000-4000-8000-000000000002", "2026-08-17T08:00:00.000Z");
    const runId = "00000000-0000-4000-8000-000000000099";
    const recordSeen = (repository as unknown as {
      recordReconciliationSeen(input: {
        whoopUserId: number;
        connectionId: string;
        reconcileRunId: string;
        resource: "sleep";
        providerId: string;
        seenAt: string;
      }): Promise<boolean>;
    }).recordReconciliationSeen.bind(repository);

    await recordSeen({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileRunId: runId,
      resource: "sleep",
      providerId: "00000000-0000-4000-8000-000000000001",
      seenAt: NOW,
    });
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: runId,
      targetId: "",
      resource: "sleep",
      windowStart: "2026-08-05T12:00:00.000Z",
      windowEnd: NOW,
      status: "retrying",
      lastError: "WHOOP synchronization failed",
    }));

    expect(database.prepare("SELECT sleep_id, deleted_at FROM whoop_sleeps ORDER BY sleep_id").all())
      .toEqual([
        { sleep_id: "00000000-0000-4000-8000-000000000001", deleted_at: null },
        { sleep_id: "00000000-0000-4000-8000-000000000002", deleted_at: null },
      ]);
    expect(database.prepare("SELECT provider_id FROM whoop_reconcile_seen").all())
      .toEqual([{ provider_id: "00000000-0000-4000-8000-000000000001" }]);
  });

  it("refuses webhook receipt and queue transitions from a stale connection lifecycle", async () => {
    const recordWebhookEvent = repository.recordWebhookEvent.bind(repository) as unknown as (input: {
      traceId: string;
      whoopUserId: number;
      connectionId: string;
      resourceId: string;
      eventType: "workout.updated";
      receivedAt: string;
    }) => Promise<boolean>;
    const markWebhookQueued = repository.markWebhookQueued.bind(repository) as unknown as (
      traceId: string,
      whoopUserId: number,
      connectionId: string,
    ) => Promise<boolean>;

    database.prepare("UPDATE whoop_connections SET connection_id = 'connection-new'").run();
    await expect(recordWebhookEvent({
      traceId: "trace-stale",
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      resourceId: WORKOUT.id,
      eventType: "workout.updated",
      receivedAt: NOW,
    })).resolves.toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM whoop_webhook_events").get())
      .toEqual({ count: 0 });

    await expect(recordWebhookEvent({
      traceId: "trace-current",
      whoopUserId: 42,
      connectionId: "connection-new",
      resourceId: WORKOUT.id,
      eventType: "workout.updated",
      receivedAt: NOW,
    })).resolves.toBe(true);
    database.prepare("UPDATE whoop_connections SET connection_id = 'connection-newer'").run();
    await expect(markWebhookQueued("trace-current", 42, "connection-new")).resolves.toBe(false);
    expect(database.prepare("SELECT status FROM whoop_webhook_events WHERE trace_id = 'trace-current'").get())
      .toEqual({ status: "received" });
  });

  it("does not apply an old connection delete event to a new connection backfill", async () => {
    const recordWebhookEvent = repository.recordWebhookEvent.bind(repository) as unknown as (input: {
      traceId: string;
      whoopUserId: number;
      connectionId: string;
      resourceId: string;
      eventType: "workout.deleted";
      receivedAt: string;
    }) => Promise<boolean>;
    await recordWebhookEvent({
      traceId: "trace-old-delete",
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      resourceId: WORKOUT.id,
      eventType: "workout.deleted",
      receivedAt: NOW,
    });
    database.prepare("UPDATE whoop_connections SET connection_id = 'connection-new'").run();

    await repository.upsertSourceRecord("workout", WORKOUT, {
      tombstonePolicy: "preserve",
      syncedAt: NOW,
      whoopUserId: 42,
      connectionId: "connection-new",
    });

    expect(database.prepare("SELECT deleted_at FROM whoop_workouts WHERE workout_id = ?")
      .get(WORKOUT.id)).toEqual({ deleted_at: null });
  });

  it("fairly rotates the bounded pending recovery batch after targeted success or failure", async () => {
    const insert = database.prepare(`
      INSERT INTO whoop_recoveries (
        sleep_id, cycle_id, whoop_user_id, score_state,
        upstream_created_at, upstream_updated_at, deleted_at, synced_at, raw_json
      ) VALUES (?, ?, 42, 'PENDING_SCORE', ?, ?, NULL, ?, '{}')
    `);
    for (let cycleId = 1; cycleId <= 30; cycleId += 1) {
      const timestamp = `2026-08-01T00:00:${String(cycleId).padStart(2, "0")}.000Z`;
      insert.run(
        `00000000-0000-4000-8000-${String(cycleId).padStart(12, "0")}`,
        cycleId,
        timestamp,
        timestamp,
        timestamp,
      );
    }

    const firstBatch = await repository.getPendingRecoveryCycleIds(42, 25);
    expect(firstBatch).toHaveLength(25);
    expect(firstBatch[0]).toBe(1);
    expect(firstBatch.at(-1)).toBe(25);

    await repository.upsertSourceRecord("recovery", {
      ...RECOVERY,
      sleep_id: "00000000-0000-4000-8000-000000000001",
      cycle_id: 1,
      score_state: "PENDING_SCORE",
    }, {
      tombstonePolicy: "reconcile",
      syncedAt: NOW,
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
    });

    const secondBatch = await repository.getPendingRecoveryCycleIds(42, 25);
    expect(secondBatch).toHaveLength(25);
    expect(secondBatch[0]).toBe(2);
    expect(secondBatch.at(-1)).toBe(26);
    expect(secondBatch).not.toContain(1);

    database.prepare(`
      UPDATE whoop_recoveries SET synced_at = '2026-08-01T00:00:01.000Z' WHERE cycle_id = 1
    `).run();
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: "00000000-0000-4000-8000-000000000099",
      targetId: "recovery-cycle:1",
      resource: "recovery",
      status: "retrying",
      updatedAt: NOW,
      lastError: "WHOOP synchronization failed",
    }));

    const failureBatch = await repository.getPendingRecoveryCycleIds(42, 25);
    expect(failureBatch[0]).toBe(2);
    expect(failureBatch.at(-1)).toBe(26);
    expect(failureBatch).not.toContain(1);
  });
});
