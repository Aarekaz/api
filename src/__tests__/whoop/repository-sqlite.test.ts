import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WhoopRepository, type CheckpointInput } from "../../services/whoop/repository";
import { CONNECTION_ID, KEY, NOW, RECOVERY, SLEEP, WORKOUT } from "./fixtures";

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
    private readonly owner: SqliteD1,
    readonly sql: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.owner, this.sql, bindings);
  }

  async first<T>(): Promise<T | null> {
    await this.owner.beforeExecute?.("first", this.sql, this.bindings);
    return (this.owner.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null;
  }

  async all<T>() {
    return {
      results: this.owner.database.prepare(this.sql).all(...this.bindings) as T[],
      success: true,
      meta: {},
    };
  }

  async run() {
    await this.owner.beforeExecute?.("run", this.sql, this.bindings);
    const result = this.owner.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  beforeExecute?: (
    operation: "first" | "run",
    sql: string,
    bindings: readonly unknown[],
  ) => Promise<void>;

  constructor(readonly database: SqliteDatabase) {}

  prepare(sql: string) {
    return new SqliteD1Statement(this, sql);
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
  reconcileGeneration: 0,
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
    await expect(repository.getSyncProgress(42)).resolves.toEqual([
      expect.objectContaining({
        resource: "recovery",
        mode: "backfill",
        status: "complete",
      }),
      expect.objectContaining({
        resource: "recovery",
        mode: "reconcile",
        status: "running",
        page_count: 1,
        record_count: 20,
      }),
    ]);
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

  it("does not refresh a checkpoint timestamp for an exact equal-state redelivery", async () => {
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: "reconcile-a",
      targetId: "",
      status: "complete",
      pageCount: 3,
      recordCount: 51,
    }));
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      syncRunId: "reconcile-a",
      targetId: "",
      status: "complete",
      pageCount: 3,
      recordCount: 51,
      updatedAt: "2026-08-19T12:30:00.000Z",
    }));

    expect(database.prepare(`
      SELECT updated_at FROM whoop_sync_checkpoints
      WHERE sync_run_id = 'reconcile-a'
    `).get()).toEqual({ updated_at: NOW });
  });

  it("fences overlapping reconciliation generations and keeps both collection progress modes", async () => {
    const lifecycle = repository as unknown as {
      beginReconciliation(whoopUserId: number, connectionId: string, begunAt: string): Promise<number | null>;
    };
    await repository.upsertCheckpoint(checkpoint({
      resource: "sleep",
      syncRunId: "initial-backfill",
      targetId: "",
      status: "complete",
      pageCount: 4,
      recordCount: 100,
    }));
    const firstGeneration = await lifecycle.beginReconciliation(42, CONNECTION_ID, NOW);
    expect(firstGeneration).toBe(1);
    await repository.upsertCheckpoint(checkpoint({
      reconcileGeneration: firstGeneration!,
      resource: "sleep",
      mode: "reconcile",
      syncRunId: "reconcile-old",
      targetId: "",
      status: "complete",
      pageCount: 2,
      recordCount: 40,
      createdAt: "2026-08-19T12:10:00.000Z",
      updatedAt: "2026-08-19T12:10:00.000Z",
    }));
    const currentGeneration = await lifecycle.beginReconciliation(
      42,
      CONNECTION_ID,
      "2026-08-19T12:20:00.000Z",
    );
    expect(currentGeneration).toBe(2);
    await repository.upsertCheckpoint(checkpoint({
      reconcileGeneration: currentGeneration!,
      resource: "sleep",
      mode: "reconcile",
      syncRunId: "reconcile-current",
      targetId: "",
      pageCount: 1,
      recordCount: 10,
      createdAt: "2026-08-19T12:05:00.000Z",
      updatedAt: "2026-08-19T12:05:00.000Z",
    }));

    await expect(repository.upsertCheckpoint(checkpoint({
      reconcileGeneration: firstGeneration!,
      resource: "sleep",
      mode: "reconcile",
      syncRunId: "reconcile-old",
      targetId: "",
      status: "complete",
      pageCount: 2,
      recordCount: 40,
      updatedAt: "2026-08-19T12:30:00.000Z",
    }))).resolves.toBe(false);
    await expect(repository.upsertSourceRecord("sleep", SLEEP, {
      tombstonePolicy: "reconcile",
      syncedAt: "2026-08-19T12:30:00.000Z",
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileGeneration: firstGeneration!,
    })).resolves.toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM whoop_sleeps").get())
      .toEqual({ count: 0 });
    await expect(repository.getSyncProgress(42)).resolves.toEqual([
      expect.objectContaining({ resource: "sleep", mode: "backfill", status: "complete" }),
      expect.objectContaining({ resource: "sleep", mode: "reconcile", status: "running" }),
    ]);
  });

  it("bounds abandoned seen sets when successive reconciliation generations begin", async () => {
    const reconciliation = repository as unknown as {
      beginReconciliation(whoopUserId: number, connectionId: string, begunAt: string): Promise<number | null>;
      recordReconciliationSeen(input: {
        whoopUserId: number;
        connectionId: string;
        reconcileGeneration: number;
        reconcileRunId: string;
        resource: "sleep";
        providerId: string;
        seenAt: string;
      }): Promise<boolean>;
    };
    for (let generation = 1; generation <= 3; generation += 1) {
      await expect(reconciliation.beginReconciliation(42, CONNECTION_ID, NOW))
        .resolves.toBe(generation);
      await expect(reconciliation.recordReconciliationSeen({
        whoopUserId: 42,
        connectionId: CONNECTION_ID,
        reconcileGeneration: generation,
        reconcileRunId: `run-${generation}`,
        resource: "sleep",
        providerId: `sleep-${generation}`,
        seenAt: NOW,
      })).resolves.toBe(true);
    }

    expect(database.prepare(`
      SELECT reconcile_generation, provider_id FROM whoop_reconcile_seen
    `).all()).toEqual([{ reconcile_generation: 3, provider_id: "sleep-3" }]);
  });

  it("never lets a late older begin cleanup delete the current generation", async () => {
    const begin = (repository as unknown as {
      beginReconciliation(whoopUserId: number, connectionId: string, begunAt: string): Promise<number | null>;
    }).beginReconciliation.bind(repository);
    let cleanupCount = 0;
    let releaseFirstCleanup!: () => void;
    const firstCleanupReleased = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    let firstCleanupStarted!: () => void;
    const firstCleanupReached = new Promise<void>((resolve) => {
      firstCleanupStarted = resolve;
    });
    d1.beforeExecute = async (operation, sql) => {
      if (operation !== "run" || !sql.includes("DELETE FROM whoop_reconcile_seen")) return;
      cleanupCount += 1;
      if (cleanupCount !== 1) return;
      firstCleanupStarted();
      await firstCleanupReleased;
    };

    const firstBegin = begin(42, CONNECTION_ID, NOW);
    await firstCleanupReached;
    database.prepare(`
      INSERT INTO whoop_reconcile_seen (
        whoop_user_id, connection_id, reconcile_generation,
        reconcile_run_id, resource, provider_id, seen_at
      ) VALUES (42, ?, 1, 'run-1', 'sleep', 'sleep-1', ?)
    `).run(CONNECTION_ID, NOW);
    await expect(begin(42, CONNECTION_ID, "2026-08-19T12:01:00.000Z"))
      .resolves.toBe(2);
    database.prepare(`
      INSERT INTO whoop_reconcile_seen (
        whoop_user_id, connection_id, reconcile_generation,
        reconcile_run_id, resource, provider_id, seen_at
      ) VALUES (42, ?, 2, 'run-2', 'sleep', 'sleep-2', ?)
    `).run(CONNECTION_ID, NOW);
    releaseFirstCleanup();
    await expect(firstBegin).resolves.toBe(1);

    expect(database.prepare(`
      SELECT reconcile_generation, provider_id FROM whoop_reconcile_seen
    `).all()).toEqual([{ reconcile_generation: 2, provider_id: "sleep-2" }]);
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
        reconcileGeneration: number;
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
      reconcileGeneration: 0,
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

  it("preserves a post-snapshot write while tombstoning an untouched omission", async () => {
    const seenId = "00000000-0000-4000-8000-000000000001";
    const lateWriteId = "00000000-0000-4000-8000-000000000002";
    const untouchedId = "00000000-0000-4000-8000-000000000003";
    insertSleep(database, seenId, "2026-08-18T08:00:00.000Z");
    insertSleep(database, lateWriteId, "2026-08-17T08:00:00.000Z");
    insertSleep(database, untouchedId, "2026-08-16T08:00:00.000Z");
    const runId = "00000000-0000-4000-8000-000000000099";
    const reconciliation = repository as unknown as {
      recordReconciliationSeen(input: {
        whoopUserId: number;
        connectionId: string;
        reconcileGeneration: number;
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
      reconcileGeneration: 0,
      reconcileRunId: runId,
      resource: "sleep",
      providerId: seenId,
      seenAt: NOW,
    });

    await repository.upsertSourceRecord("sleep", {
      ...SLEEP,
      id: lateWriteId,
    }, {
      tombstonePolicy: "preserve",
      syncedAt: "2026-08-19T08:00:00.250-04:00",
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
    });
    await expect(reconciliation.finalizeReconciliation(checkpoint({
      mode: "reconcile",
      syncRunId: runId,
      targetId: "",
      resource: "sleep",
      windowStart: "2026-08-05T08:00:00-04:00",
      windowEnd: "2026-08-19T08:00:00-04:00",
      status: "complete",
      pageCount: 1,
      recordCount: 1,
    }))).resolves.toBe(true);

    expect(database.prepare(`
      SELECT sleep_id, deleted_at, synced_at FROM whoop_sleeps ORDER BY sleep_id
    `).all()).toEqual([
      { sleep_id: seenId, deleted_at: null, synced_at: NOW },
      {
        sleep_id: lateWriteId,
        deleted_at: null,
        synced_at: "2026-08-19T12:00:00.250Z",
      },
      { sleep_id: untouchedId, deleted_at: NOW, synced_at: NOW },
    ]);
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
        reconcileGeneration: number;
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
      reconcileGeneration: 0,
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
      reconcileGeneration: 0,
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
      reconcileGeneration: 0,
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
        reconcileGeneration: number;
        reconcileRunId: string;
        resource: "sleep";
        providerId: string;
        seenAt: string;
      }): Promise<boolean>;
    }).recordReconciliationSeen.bind(repository);

    await recordSeen({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileGeneration: 0,
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
    const getWebhookEventStatus = repository.getWebhookEventStatus.bind(repository);

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
    await expect(getWebhookEventStatus("trace-current", 42, "connection-new"))
      .resolves.toBe("received");
    database.prepare("UPDATE whoop_connections SET connection_id = 'connection-newer'").run();
    await expect(markWebhookQueued("trace-current", 42, "connection-new")).resolves.toBe(false);
    await expect(getWebhookEventStatus("trace-current", 42, "connection-new"))
      .resolves.toBeNull();
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

  it("lifecycle-fences connection health and derives run totals without redelivery double counts", async () => {
    database.prepare("UPDATE whoop_connections SET reconcile_generation = 1").run();
    await repository.createSyncRun({
      runId: "run-health",
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileGeneration: 1,
      trigger: "manual",
      expectedTargetCount: 2,
      startedAt: NOW,
    });
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      reconcileGeneration: 1,
      syncRunId: "run-health",
      targetId: "",
      resource: "sleep",
      status: "complete",
      pageCount: 2,
      recordCount: 30,
    }));
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      reconcileGeneration: 1,
      syncRunId: "run-health",
      targetId: "",
      resource: "workout",
      status: "retrying",
      pageCount: 1,
      recordCount: 4,
      lastError: "WHOOP request failed with status 503",
    }));

    await expect(repository.refreshSyncRun("run-health", 42, CONNECTION_ID, 1, NOW))
      .resolves.toBe(true);
    await expect(repository.refreshSyncRun("run-health", 42, CONNECTION_ID, 1, NOW))
      .resolves.toBe(true);
    expect(database.prepare(`
      SELECT status, page_count, record_count, expected_target_count, completed_target_count
      FROM whoop_sync_runs WHERE run_id = 'run-health'
    `).get()).toEqual({
      status: "retrying",
      page_count: 3,
      record_count: 34,
      expected_target_count: 2,
      completed_target_count: 1,
    });
    await repository.upsertCheckpoint(checkpoint({
      mode: "reconcile",
      reconcileGeneration: 1,
      syncRunId: "run-health",
      targetId: "",
      resource: "workout",
      status: "complete",
      pageCount: 1,
      recordCount: 4,
    }));
    await repository.refreshSyncRun(
      "run-health", 42, CONNECTION_ID, 1, "2026-08-19T12:01:00.000Z",
    );
    expect(database.prepare(`
      SELECT status, page_count, record_count, completed_target_count, succeeded_at
      FROM whoop_sync_runs WHERE run_id = 'run-health'
    `).get()).toEqual({
      status: "complete",
      page_count: 3,
      record_count: 34,
      completed_target_count: 2,
      succeeded_at: "2026-08-19T12:01:00.000Z",
    });

    await expect(repository.recordSyncFailure(
      42, CONNECTION_ID, NOW, "WHOOP request failed with status 503",
    )).resolves.toBe(true);
    await expect(repository.recordSyncSuccess(42, CONNECTION_ID, "2026-08-19T12:01:00.000Z"))
      .resolves.toBe(true);
    expect(database.prepare(`
      SELECT last_success_at, last_error_at, last_error, consecutive_failure_count
      FROM whoop_connections WHERE whoop_user_id = 42
    `).get()).toEqual({
      last_success_at: "2026-08-19T12:01:00.000Z",
      last_error_at: null,
      last_error: null,
      consecutive_failure_count: 0,
    });
    database.prepare("UPDATE whoop_connections SET connection_id = 'replacement'").run();
    await expect(repository.recordSyncFailure(42, CONNECTION_ID, NOW, "stale"))
      .resolves.toBe(false);
  });

  it("prunes only bounded terminal operational data and preserves deletion receipts and latest progress", async () => {
    database.exec(`
      INSERT INTO whoop_oauth_states VALUES ('old-state', '2026-06-01T00:00:00.000Z', '2026-06-01T00:10:00.000Z', NULL);
      INSERT INTO whoop_oauth_states VALUES ('fresh-state', '2026-08-19T11:50:00.000Z', '2026-08-19T12:10:00.000Z', NULL);
      INSERT INTO whoop_webhook_events VALUES ('old-update', 42, '${CONNECTION_ID}', 'x', 'sleep.updated', '2026-06-01T00:00:00.000Z', '2026-06-01T00:01:00.000Z', 'processed', 1, NULL);
      INSERT INTO whoop_webhook_events VALUES ('old-delete', 42, '${CONNECTION_ID}', 'x', 'sleep.deleted', '2026-06-01T00:00:00.000Z', '2026-06-01T00:01:00.000Z', 'processed', 1, NULL);
      INSERT INTO whoop_webhook_events VALUES ('old-queued', 42, '${CONNECTION_ID}', 'x', 'sleep.updated', '2026-06-01T00:00:00.000Z', NULL, 'queued', 1, NULL);
    `);
    await repository.upsertCheckpoint(checkpoint({
      syncRunId: "old",
      targetId: "",
      status: "complete",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    }));
    await repository.upsertCheckpoint(checkpoint({
      syncRunId: "old-targeted",
      targetId: "recovery-cycle:9",
      status: "error",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    }));
    await repository.upsertCheckpoint(checkpoint({ syncRunId: "latest", targetId: "", status: "complete", updatedAt: NOW, createdAt: NOW }));

    await repository.pruneOperationalData(NOW);

    expect(database.prepare("SELECT state_hash FROM whoop_oauth_states ORDER BY state_hash").all())
      .toEqual([{ state_hash: "fresh-state" }]);
    expect(database.prepare("SELECT trace_id FROM whoop_webhook_events ORDER BY trace_id").all())
      .toEqual([{ trace_id: "old-delete" }, { trace_id: "old-queued" }]);
    expect(database.prepare("SELECT sync_run_id FROM whoop_sync_checkpoints ORDER BY sync_run_id").all())
      .toEqual([{ sync_run_id: "latest" }]);
  });

  it("prunes abandoned nonterminal work only after grace while preserving current work", async () => {
    database.prepare("UPDATE whoop_connections SET reconcile_generation = 3, status = 'active'").run();
    const insertCheckpoint = database.prepare(`
      INSERT INTO whoop_sync_checkpoints (
        whoop_user_id, connection_id, resource, mode, reconcile_generation,
        sync_run_id, target_id, status, page_count, record_count, created_at, updated_at
      ) VALUES (42, ?, ?, 'reconcile', ?, ?, '', ?, 0, 0, ?, ?)
    `);
    const old = "2026-08-17T00:00:00.000Z";
    const withinGrace = "2026-08-19T06:00:00.000Z";
    insertCheckpoint.run(CONNECTION_ID, "sleep", 3, "current-running", "running", old, old);
    insertCheckpoint.run(CONNECTION_ID, "workout", 3, "current-retrying", "retrying", old, old);
    insertCheckpoint.run(CONNECTION_ID, "cycle", 3, "current-queued", "queued", old, old);
    insertCheckpoint.run(CONNECTION_ID, "sleep", 2, "superseded-recent", "retrying", withinGrace, withinGrace);
    insertCheckpoint.run(CONNECTION_ID, "sleep", 1, "superseded-old", "queued", old, old);
    insertCheckpoint.run("old-connection", "sleep", 8, "old-lifecycle", "running", old, old);

    const insertRun = database.prepare(`
      INSERT INTO whoop_sync_runs (
        run_id, whoop_user_id, connection_id, reconcile_generation, trigger, status,
        expected_target_count, completed_target_count, page_count, record_count, started_at
      ) VALUES (?, 42, ?, ?, 'scheduled', ?, 6, 0, 0, 0, ?)
    `);
    insertRun.run("current-queued", CONNECTION_ID, 3, "queued", old);
    insertRun.run("current-running", CONNECTION_ID, 3, "running", old);
    insertRun.run("current-retrying", CONNECTION_ID, 3, "retrying", old);
    insertRun.run("superseded-recent", CONNECTION_ID, 2, "retrying", withinGrace);
    insertRun.run("superseded-old", CONNECTION_ID, 1, "running", old);
    insertRun.run("old-lifecycle", "old-connection", 8, "queued", old);

    await repository.pruneOperationalData(NOW);

    expect(database.prepare("SELECT sync_run_id FROM whoop_sync_checkpoints ORDER BY sync_run_id").all())
      .toEqual([
        { sync_run_id: "current-queued" },
        { sync_run_id: "current-retrying" },
        { sync_run_id: "current-running" },
        { sync_run_id: "superseded-recent" },
      ]);
    expect(database.prepare("SELECT run_id FROM whoop_sync_runs ORDER BY run_id").all())
      .toEqual([
        { run_id: "current-queued" },
        { run_id: "current-retrying" },
        { run_id: "current-running" },
        { run_id: "superseded-recent" },
      ]);
  });

  it("does not let abandoned nonterminal work supersede the useful terminal projection", async () => {
    database.prepare("UPDATE whoop_connections SET reconcile_generation = 3, status = 'active'").run();
    const insertCheckpoint = database.prepare(`
      INSERT INTO whoop_sync_checkpoints (
        whoop_user_id, connection_id, resource, mode, reconcile_generation,
        sync_run_id, target_id, status, page_count, record_count, created_at, updated_at
      ) VALUES (42, ?, 'sleep', 'reconcile', ?, ?, ?, ?, 0, 0, ?, ?)
    `);
    const oldTerminal = "2026-06-01T00:00:00.000Z";
    const abandoned = "2026-08-17T00:00:00.000Z";
    insertCheckpoint.run(CONNECTION_ID, 1, "useful-terminal", "", "complete", oldTerminal, oldTerminal);
    insertCheckpoint.run(CONNECTION_ID, 2, "abandoned-newer", "", "retrying", abandoned, abandoned);
    insertCheckpoint.run(
      CONNECTION_ID, 2, "different-target", "recovery-cycle:9", "complete", NOW, NOW,
    );

    const insertRun = database.prepare(`
      INSERT INTO whoop_sync_runs (
        run_id, whoop_user_id, connection_id, reconcile_generation, trigger, status,
        expected_target_count, completed_target_count, page_count, record_count, started_at
      ) VALUES (?, 42, ?, ?, 'scheduled', ?, 6, 0, 0, 0, ?)
    `);
    insertRun.run("useful-terminal", CONNECTION_ID, 1, "complete", oldTerminal);
    insertRun.run("abandoned-newer", CONNECTION_ID, 2, "running", abandoned);

    await expect(repository.pruneOperationalData(NOW)).resolves.toEqual(expect.objectContaining({
      checkpoints: 1,
      runs: 1,
    }));
    expect(database.prepare("SELECT sync_run_id FROM whoop_sync_checkpoints ORDER BY sync_run_id").all())
      .toEqual([{ sync_run_id: "different-target" }, { sync_run_id: "useful-terminal" }]);
    expect(database.prepare("SELECT run_id FROM whoop_sync_runs").all())
      .toEqual([{ run_id: "useful-terminal" }]);
  });

  it("prunes terminal history through repeated bounded sweeps within its projection partition", async () => {
    const old = "2026-06-01T00:00:00.000Z";
    const newest = "2026-08-19T12:00:00.000Z";
    const insertCheckpoint = database.prepare(`
      INSERT INTO whoop_sync_checkpoints (
        whoop_user_id, connection_id, resource, mode, reconcile_generation,
        sync_run_id, target_id, status, page_count, record_count, created_at, updated_at
      ) VALUES (42, ?, ?, 'reconcile', ?, ?, '', 'complete', 0, 0, ?, ?)
    `);
    for (let index = 0; index < 102; index += 1) {
      insertCheckpoint.run(
        CONNECTION_ID, "sleep", 1, `old-checkpoint-${index.toString().padStart(3, "0")}`, old, old,
      );
    }
    insertCheckpoint.run(CONNECTION_ID, "sleep", 2, "newest-checkpoint", newest, newest);
    insertCheckpoint.run(CONNECTION_ID, "workout", 1, "different-resource", old, old);
    insertCheckpoint.run("old-connection", "sleep", 1, "different-lifecycle", old, old);

    const insertRun = database.prepare(`
      INSERT INTO whoop_sync_runs (
        run_id, whoop_user_id, connection_id, reconcile_generation, trigger, status,
        expected_target_count, completed_target_count, page_count, record_count, started_at
      ) VALUES (?, 42, ?, ?, 'scheduled', 'complete', 6, 6, 0, 0, ?)
    `);
    for (let index = 0; index < 102; index += 1) {
      insertRun.run(`old-run-${index.toString().padStart(3, "0")}`, CONNECTION_ID, 1, old);
    }
    insertRun.run("newest-run", CONNECTION_ID, 2, newest);
    insertRun.run("different-lifecycle", "old-connection", 1, old);

    await expect(repository.pruneOperationalData(NOW)).resolves.toEqual(expect.objectContaining({
      checkpoints: 100,
      runs: 100,
    }));
    await expect(repository.pruneOperationalData(NOW)).resolves.toEqual(expect.objectContaining({
      checkpoints: 2,
      runs: 2,
    }));
    await expect(repository.pruneOperationalData(NOW)).resolves.toEqual(expect.objectContaining({
      checkpoints: 0,
      runs: 0,
    }));

    expect(database.prepare("SELECT sync_run_id FROM whoop_sync_checkpoints ORDER BY sync_run_id").all())
      .toEqual([
        { sync_run_id: "different-lifecycle" },
        { sync_run_id: "different-resource" },
        { sync_run_id: "newest-checkpoint" },
      ]);
    expect(database.prepare("SELECT run_id FROM whoop_sync_runs ORDER BY run_id").all())
      .toEqual([{ run_id: "different-lifecycle" }, { run_id: "newest-run" }]);
  });
});
