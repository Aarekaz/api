import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import { WhoopRequestError } from "../../services/whoop/client";
import {
  enqueueReconciliation,
  handleWhoopQueue,
  processWebhook,
  type WhoopSyncDependencies,
} from "../../services/whoop/sync";
import type { Env } from "../../types/env";
import type { WhoopQueueMessage } from "../../types/whoop";
import {
  BODY_MEASUREMENT,
  CONNECTION_ID,
  ENV,
  NOW,
  PROFILE,
  RECONCILE_RUN_ID,
  RECOVERY,
  SLEEP,
  WORKOUT,
  batchOf,
} from "./fixtures";

const createHarness = () => {
  const repository = {
    upsertSourceRecord: vi.fn().mockResolvedValue(undefined),
    tombstoneSourceRecord: vi.fn().mockResolvedValue(undefined),
    upsertCheckpoint: vi.fn().mockResolvedValue(undefined),
    recordReconciliationSeen: vi.fn().mockResolvedValue(undefined),
    finalizeReconciliation: vi.fn().mockResolvedValue(undefined),
    cleanupReconciliationSeen: vi.fn().mockResolvedValue(true),
    markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
    markWebhookFailed: vi.fn().mockResolvedValue(undefined),
    getPendingRecoveryCycleIds: vi.fn().mockResolvedValue([]),
    beginReconciliation: vi.fn().mockResolvedValue(7),
    getCurrentConnection: vi.fn().mockResolvedValue({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      credentialVersion: 1,
      reconcileGeneration: 0,
      status: "active",
    }),
    isSyncConnectionCurrent: vi.fn().mockResolvedValue(true),
    isReconciliationCurrent: vi.fn().mockResolvedValue(true),
    activateCompletedBackfill: vi.fn().mockResolvedValue(false),
  };
  const client = {
    getProfile: vi.fn(),
    getBodyMeasurements: vi.fn(),
    getCollection: vi.fn(),
    getCycle: vi.fn(),
    getRecovery: vi.fn(),
    getSleep: vi.fn(),
    getWorkout: vi.fn(),
  };
  const env = {
    ...ENV,
    WHOOP_SYNC_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue<WhoopQueueMessage>,
  } as Env;
  const dependencies = {
    repository,
    client,
    now: () => new Date(NOW),
  } as unknown as WhoopSyncDependencies;

  return { client, dependencies, env, repository };
};

type QueueMessageInput = WhoopQueueMessage extends infer Message
  ? Message extends WhoopQueueMessage
    ? Omit<Message, "connectionId" | "reconcileGeneration" | "reconcileRunId"> & {
      connectionId?: string;
      reconcileGeneration?: number;
      reconcileRunId?: string;
    }
    : never
  : never;

const batchOfMany = (...bodies: QueueMessageInput[]) => ({
  messages: bodies.map((body, index) => ({
    id: `message-${index}`,
    timestamp: new Date(NOW),
    attempts: 1,
    body: {
      connectionId: CONNECTION_ID,
      ...(body.kind === "reconcile"
        ? { reconcileGeneration: 7, reconcileRunId: RECONCILE_RUN_ID }
        : {}),
      ...body,
    },
    ack: vi.fn(),
    retry: vi.fn(),
  })),
}) as unknown as MessageBatch<WhoopQueueMessage>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WHOOP queue synchronization", () => {
  it("durably persists one backfill page and follows only its returned cursor", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getCollection.mockResolvedValue({ records: [SLEEP], nextToken: "opaque-next" });
    const batch = batchOf({ kind: "backfill", whoopUserId: 42, resource: "sleep" });
    const message = batch.messages[0];

    await handleWhoopQueue(batch, env, dependencies);

    expect(client.getCollection).toHaveBeenCalledWith("sleep", { limit: 25 });
    expect(repository.upsertSourceRecord).toHaveBeenCalledWith(
      "sleep",
      SLEEP,
      { tombstonePolicy: "preserve", syncedAt: NOW, whoopUserId: 42, connectionId: CONNECTION_ID },
    );
    expect(repository.upsertCheckpoint).toHaveBeenCalledWith({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileGeneration: 0,
      resource: "sleep",
      mode: "backfill",
      syncRunId: "initial-backfill",
      targetId: "",
      windowStart: null,
      windowEnd: null,
      nextToken: "opaque-next",
      status: "running",
      pageCount: 1,
      recordCount: 1,
      createdAt: NOW,
      updatedAt: NOW,
      lastError: null,
    });
    expect(env.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledTimes(1);
    expect(env.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledWith({
      kind: "backfill",
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      resource: "sleep",
      nextToken: "opaque-next",
      pageCount: 1,
      recordCount: 1,
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("completes a non-paginated profile backfill through the profile endpoint", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getProfile.mockResolvedValue(PROFILE);
    const batch = batchOf({ kind: "backfill", whoopUserId: 42, resource: "profile" });
    const message = batch.messages[0];

    await handleWhoopQueue(batch, env, dependencies);

    expect(client.getProfile).toHaveBeenCalledTimes(1);
    expect(client.getCollection).not.toHaveBeenCalled();
    expect(repository.upsertSourceRecord).toHaveBeenCalledWith(
      "profile",
      PROFILE,
      { tombstonePolicy: "preserve", syncedAt: NOW, whoopUserId: 42, connectionId: CONNECTION_ID },
    );
    expect(repository.upsertCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      whoopUserId: 42,
      resource: "profile",
      mode: "backfill",
      nextToken: null,
      status: "complete",
      pageCount: 1,
      recordCount: 1,
      lastError: null,
    }));
    expect(env.WHOOP_SYNC_QUEUE.send).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("adds connection identity before persisting body measurements", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getBodyMeasurements.mockResolvedValue(BODY_MEASUREMENT);
    const batch = batchOf({ kind: "backfill", whoopUserId: 42, resource: "body_measurement" });
    const message = batch.messages[0];

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.upsertSourceRecord).toHaveBeenCalledWith(
      "body_measurement",
      { ...BODY_MEASUREMENT, whoop_user_id: 42 },
      { tombstonePolicy: "preserve", syncedAt: NOW, whoopUserId: 42, connectionId: CONNECTION_ID },
    );
    expect(repository.upsertCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      resource: "body_measurement",
      status: "complete",
      pageCount: 1,
      recordCount: 1,
    }));
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("reconciles collection results authoritatively over an exact 14-day window", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getCollection.mockResolvedValue({ records: [SLEEP] });
    const batch = batchOf({ kind: "reconcile", whoopUserId: 42, resource: "sleep" });
    const message = batch.messages[0];

    await handleWhoopQueue(batch, env, dependencies);

    expect(client.getCollection).toHaveBeenCalledWith("sleep", {
      limit: 25,
      start: "2026-08-05T12:00:00.000Z",
      end: NOW,
    });
    expect(repository.upsertSourceRecord).toHaveBeenCalledWith(
      "sleep",
      SLEEP,
      {
        tombstonePolicy: "reconcile",
        syncedAt: NOW,
        whoopUserId: 42,
        connectionId: CONNECTION_ID,
        reconcileGeneration: 7,
      },
    );
    expect(repository.finalizeReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "reconcile",
      reconcileGeneration: 7,
      syncRunId: RECONCILE_RUN_ID,
      targetId: "",
      windowStart: "2026-08-05T12:00:00.000Z",
      windowEnd: NOW,
      nextToken: null,
      status: "complete",
    }));
    expect(env.WHOOP_SYNC_QUEUE.send).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("retries a pending recovery by its bounded cycle identifier", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getRecovery.mockResolvedValue(RECOVERY);
    const batch = batchOf({
      kind: "reconcile",
      whoopUserId: 42,
      resource: "recovery",
      recoveryCycleId: 9,
    });

    await handleWhoopQueue(batch, env, dependencies);

    expect(client.getRecovery).toHaveBeenCalledWith(9);
    expect(client.getCollection).not.toHaveBeenCalled();
    expect(repository.upsertSourceRecord).toHaveBeenCalledWith(
      "recovery",
      RECOVERY,
      {
        tombstonePolicy: "reconcile",
        syncedAt: NOW,
        whoopUserId: 42,
        connectionId: CONNECTION_ID,
        reconcileGeneration: 7,
      },
    );
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
  });

  it("queues a 14-day reconciliation plus bounded pending recovery retries", async () => {
    const { dependencies, env, repository } = createHarness();
    repository.getPendingRecoveryCycleIds.mockResolvedValue([9, 10]);

    await enqueueReconciliation(env, 42, "scheduled", dependencies);

    expect(repository.getPendingRecoveryCycleIds).toHaveBeenCalledWith(42, 25);
    expect(repository.beginReconciliation).toHaveBeenCalledWith(42, CONNECTION_ID, NOW);
    expect(env.WHOOP_SYNC_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    const queuedBodies = (env.WHOOP_SYNC_QUEUE.sendBatch as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0].map(({ body }: { body: WhoopQueueMessage }) => body);
    const runIds: string[] = queuedBodies.map((body: WhoopQueueMessage) => {
      if (body.kind !== "reconcile") throw new Error("Expected reconciliation message");
      return body.reconcileRunId;
    });
    expect(new Set(runIds).size).toBe(1);
    expect(runIds[0]).toEqual(expect.any(String));
    const reconcileRunId = runIds[0];
    expect(env.WHOOP_SYNC_QUEUE.sendBatch).toHaveBeenCalledWith([
      { body: { kind: "reconcile", whoopUserId: 42, connectionId: CONNECTION_ID, reconcileGeneration: 7, reconcileRunId, resource: "profile", trigger: "scheduled" } },
      { body: { kind: "reconcile", whoopUserId: 42, connectionId: CONNECTION_ID, reconcileGeneration: 7, reconcileRunId, resource: "body_measurement", trigger: "scheduled" } },
      ...(["cycle", "recovery", "sleep", "workout"] as const).map((resource) => ({
        body: {
          kind: "reconcile" as const,
          whoopUserId: 42,
          connectionId: CONNECTION_ID,
          reconcileGeneration: 7,
          reconcileRunId,
          resource,
          windowStart: "2026-08-05T12:00:00.000Z",
          windowEnd: NOW,
          trigger: "scheduled",
        },
      })),
      { body: { kind: "reconcile", whoopUserId: 42, connectionId: CONNECTION_ID, reconcileGeneration: 7, reconcileRunId, resource: "recovery", recoveryCycleId: 9, trigger: "scheduled" } },
      { body: { kind: "reconcile", whoopUserId: 42, connectionId: CONNECTION_ID, reconcileGeneration: 7, reconcileRunId, resource: "recovery", recoveryCycleId: 10, trigger: "scheduled" } },
    ]);
  });

  it("rejects a replacement lifecycle and backfilling status required to stay active", async () => {
    const { dependencies, env, repository } = createHarness();
    repository.getCurrentConnection.mockResolvedValue({
      whoopUserId: 42,
      connectionId: "connection-c2",
      credentialVersion: 2,
      reconcileGeneration: 0,
      status: "backfilling",
    });

    await expect(enqueueReconciliation(env, 42, "scheduled", {
      ...dependencies,
      expectedConnectionId: "connection-c1",
      requireActiveConnection: true,
    } as unknown as Parameters<typeof enqueueReconciliation>[3])).rejects.toThrow(
      "WHOOP connection is not available for reconciliation",
    );

    expect(repository.beginReconciliation).not.toHaveBeenCalled();
    expect(repository.getPendingRecoveryCycleIds).not.toHaveBeenCalled();
    expect(env.WHOOP_SYNC_QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  it("requires the begin-generation CAS to preserve active status after its reread", async () => {
    const { dependencies, env, repository } = createHarness();
    repository.beginReconciliation.mockResolvedValue(null);

    await expect(enqueueReconciliation(env, 42, "scheduled", {
      ...dependencies,
      expectedConnectionId: CONNECTION_ID,
      requireActiveConnection: true,
    } as unknown as Parameters<typeof enqueueReconciliation>[3])).rejects.toThrow(
      "WHOOP connection changed before reconciliation began",
    );

    expect(repository.beginReconciliation).toHaveBeenCalledWith(42, CONNECTION_ID, NOW, true);
    expect(repository.getPendingRecoveryCycleIds).not.toHaveBeenCalled();
    expect(env.WHOOP_SYNC_QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  it("records every returned provider ID before atomically finalizing the last reconciliation page", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getCollection.mockResolvedValue({ records: [SLEEP] });
    const batch = batchOf({ kind: "reconcile", whoopUserId: 42, resource: "sleep" });

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.recordReconciliationSeen).toHaveBeenCalledWith({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileGeneration: 7,
      reconcileRunId: RECONCILE_RUN_ID,
      resource: "sleep",
      providerId: SLEEP.id,
      seenAt: NOW,
    });
    expect(repository.finalizeReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      reconcileGeneration: 7,
      syncRunId: RECONCILE_RUN_ID,
      targetId: "",
      status: "complete",
      pageCount: 1,
      recordCount: 1,
    }));
    expect(repository.upsertCheckpoint).not.toHaveBeenCalled();
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
  });

  it("retains the stable reconciliation run on a non-final next-page message", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getCollection.mockResolvedValue({ records: [SLEEP], nextToken: "opaque-next" });
    const batch = batchOf({ kind: "reconcile", whoopUserId: 42, resource: "sleep" });

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.recordReconciliationSeen).toHaveBeenCalledTimes(1);
    expect(repository.finalizeReconciliation).not.toHaveBeenCalled();
    expect(repository.upsertCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      reconcileGeneration: 7,
      syncRunId: RECONCILE_RUN_ID,
      targetId: "",
      status: "running",
    }));
    expect(env.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      reconcileGeneration: 7,
      reconcileRunId: RECONCILE_RUN_ID,
      nextToken: "opaque-next",
    }));
  });

  it("resolves recovery updates from sleep UUID to cycle recovery", async () => {
    const { client, dependencies, repository } = createHarness();
    client.getSleep.mockResolvedValue(SLEEP);
    client.getRecovery.mockResolvedValue(RECOVERY);

    await processWebhook({
      eventType: "recovery.updated",
      resourceId: SLEEP.id,
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
    }, dependencies);

    expect(client.getSleep).toHaveBeenCalledWith(SLEEP.id);
    expect(client.getRecovery).toHaveBeenCalledWith(SLEEP.cycle_id);
    expect(repository.upsertSourceRecord).toHaveBeenCalledWith(
      "recovery",
      RECOVERY,
      { tombstonePolicy: "preserve", syncedAt: NOW, whoopUserId: 42, connectionId: CONNECTION_ID },
    );
  });

  it("fetches and preserves an authoritative workout update", async () => {
    const { client, dependencies, repository } = createHarness();
    client.getWorkout.mockResolvedValue(WORKOUT);

    await processWebhook({
      eventType: "workout.updated",
      resourceId: WORKOUT.id,
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
    }, dependencies);

    expect(client.getWorkout).toHaveBeenCalledWith(WORKOUT.id);
    expect(repository.upsertSourceRecord).toHaveBeenCalledWith(
      "workout",
      WORKOUT,
      { tombstonePolicy: "preserve", syncedAt: NOW, whoopUserId: 42, connectionId: CONNECTION_ID },
    );
  });

  it("fetches and preserves an authoritative sleep update", async () => {
    const { client, dependencies, repository } = createHarness();
    client.getSleep.mockResolvedValue(SLEEP);

    await processWebhook({
      eventType: "sleep.updated",
      resourceId: SLEEP.id,
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
    }, dependencies);

    expect(client.getSleep).toHaveBeenCalledWith(SLEEP.id);
    expect(repository.upsertSourceRecord).toHaveBeenCalledWith(
      "sleep",
      SLEEP,
      { tombstonePolicy: "preserve", syncedAt: NOW, whoopUserId: 42, connectionId: CONNECTION_ID },
    );
  });

  it("tombstones webhook deletions without fetching provider data", async () => {
    const { client, dependencies, repository } = createHarness();

    await processWebhook({ eventType: "workout.deleted", resourceId: WORKOUT.id, whoopUserId: 42, connectionId: CONNECTION_ID }, dependencies);
    await processWebhook({ eventType: "sleep.deleted", resourceId: SLEEP.id, whoopUserId: 42, connectionId: CONNECTION_ID }, dependencies);
    await processWebhook({ eventType: "recovery.deleted", resourceId: SLEEP.id, whoopUserId: 42, connectionId: CONNECTION_ID }, dependencies);

    expect(repository.tombstoneSourceRecord.mock.calls).toEqual([
      ["workout", WORKOUT.id, NOW, { whoopUserId: 42, connectionId: CONNECTION_ID }],
      ["sleep", SLEEP.id, NOW, { whoopUserId: 42, connectionId: CONNECTION_ID }],
      ["recovery", SLEEP.id, NOW, { whoopUserId: 42, connectionId: CONNECTION_ID }],
    ]);
    expect(client.getWorkout).not.toHaveBeenCalled();
    expect(client.getSleep).not.toHaveBeenCalled();
    expect(client.getRecovery).not.toHaveBeenCalled();
  });

  it("acknowledges a webhook only after source persistence and durable event completion", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getWorkout.mockResolvedValue(WORKOUT);
    const batch = batchOf({
      kind: "webhook",
      traceId: "trace-workout-update",
      whoopUserId: 42,
      resourceId: WORKOUT.id,
      eventType: "workout.updated",
    });
    const message = batch.messages[0];

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.upsertSourceRecord).toHaveBeenCalledTimes(1);
    expect(repository.markWebhookProcessed).toHaveBeenCalledWith(
      "trace-workout-update",
      42,
      CONNECTION_ID,
      NOW,
    );
    expect(repository.upsertSourceRecord.mock.invocationCallOrder[0])
      .toBeLessThan(repository.markWebhookProcessed.mock.invocationCallOrder[0]);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("checkpoints a sanitized retryable failure and retries without acknowledging", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getCollection.mockRejectedValue(new WhoopRequestError("list sleep", 429, true, 30));
    const batch = batchOf({ kind: "backfill", whoopUserId: 42, resource: "sleep" });
    const message = batch.messages[0];

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.upsertCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      whoopUserId: 42,
      resource: "sleep",
      mode: "backfill",
      nextToken: null,
      status: "retrying",
      pageCount: 0,
      recordCount: 0,
      lastError: "WHOOP request failed with status 429",
    }));
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("durably terminates an explicit permanent 4xx without a retry loop", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getCollection.mockRejectedValue(new WhoopRequestError("list workout", 404));
    const batch = batchOf({
      kind: "reconcile",
      whoopUserId: 42,
      resource: "workout",
      pageCount: 2,
      recordCount: 25,
    });
    const message = batch.messages[0];

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.upsertCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      reconcileGeneration: 7,
      status: "error",
      pageCount: 2,
      recordCount: 25,
      lastError: "WHOOP request failed with status 404",
    }));
    expect(repository.cleanupReconciliationSeen).toHaveBeenCalledWith({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      reconcileGeneration: 7,
      reconcileRunId: RECONCILE_RUN_ID,
      resource: "workout",
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("does not clear collection seen IDs when a targeted recovery permanently fails", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getRecovery.mockRejectedValue(new WhoopRequestError("get recovery", 404));
    const batch = batchOf({
      kind: "reconcile",
      whoopUserId: 42,
      resource: "recovery",
      recoveryCycleId: 9,
    });

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.upsertCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "recovery-cycle:9",
      status: "error",
    }));
    expect(repository.cleanupReconciliationSeen).not.toHaveBeenCalled();
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });

  it("durably records a sanitized webhook retry before requesting redelivery", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getWorkout.mockRejectedValue(new WhoopRequestError("get workout", 503, true, 15));
    const batch = batchOf({
      kind: "webhook",
      traceId: "trace-retry",
      whoopUserId: 42,
      resourceId: WORKOUT.id,
      eventType: "workout.updated",
    });
    const message = batch.messages[0];

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.markWebhookFailed).toHaveBeenCalledWith(
      "trace-retry",
      42,
      CONNECTION_ID,
      "retrying",
      "WHOOP request failed with status 503",
      NOW,
    );
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("retries one failed message without suppressing later batch messages", async () => {
    const { client, dependencies, env } = createHarness();
    client.getCollection
      .mockRejectedValueOnce(new WhoopRequestError("list sleep", 503, true, 20))
      .mockResolvedValueOnce({ records: [WORKOUT] });
    const batch = batchOfMany(
      { kind: "backfill", whoopUserId: 42, resource: "sleep" },
      { kind: "backfill", whoopUserId: 42, resource: "workout" },
    );

    await handleWhoopQueue(batch, env, dependencies);

    expect(batch.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(batch.messages[0].ack).not.toHaveBeenCalled();
    expect(batch.messages[1].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[1].retry).not.toHaveBeenCalled();
    expect(client.getCollection).toHaveBeenCalledTimes(2);
  });

  it("mounts the WHOOP queue consumer on the Worker export", async () => {
    const queue = (worker as unknown as {
      queue?: (batch: MessageBatch<WhoopQueueMessage>, env: Env) => Promise<void>;
    }).queue;
    const emptyBatch = batchOfMany();

    expect(queue).toEqual(expect.any(Function));
    await expect(queue!(emptyBatch, ENV)).resolves.toBeUndefined();
  });

  it("preserves the returned cursor when next-page publication is ambiguous", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getCollection.mockResolvedValue({ records: [SLEEP], nextToken: "returned-cursor" });
    (env.WHOOP_SYNC_QUEUE.send as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("queue outcome unknown"));
    const batch = batchOf({
      kind: "backfill",
      whoopUserId: 42,
      resource: "sleep",
      nextToken: "current-cursor",
      pageCount: 2,
      recordCount: 25,
    });

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.upsertCheckpoint).toHaveBeenCalledTimes(1);
    expect(repository.upsertCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      nextToken: "returned-cursor",
      pageCount: 3,
      recordCount: 26,
    }));
    expect(batch.messages[0].retry).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].ack).not.toHaveBeenCalled();
  });

  it("processes queued deletion tombstones without loading OAuth credentials", async () => {
    const { dependencies, env, repository } = createHarness();
    const batch = batchOf({
      kind: "webhook",
      traceId: "trace-delete",
      whoopUserId: 42,
      resourceId: WORKOUT.id,
      eventType: "workout.deleted",
    });
    const dependenciesWithoutClient = {
      repository: dependencies.repository,
      now: dependencies.now,
    } as WhoopSyncDependencies;

    await handleWhoopQueue(batch, env, dependenciesWithoutClient);

    expect(repository.tombstoneSourceRecord).toHaveBeenCalledWith(
      "workout",
      WORKOUT.id,
      NOW,
      { whoopUserId: 42, connectionId: CONNECTION_ID },
    );
    expect(repository.markWebhookProcessed).toHaveBeenCalledWith(
      "trace-delete",
      42,
      CONNECTION_ID,
      NOW,
    );
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });

  it("acknowledges stale connection work before any provider request or source write", async () => {
    const { client, dependencies, env, repository } = createHarness();
    repository.isSyncConnectionCurrent.mockResolvedValue(false);
    const batch = batchOf({
      kind: "backfill",
      whoopUserId: 42,
      connectionId: "stale-connection-id",
      resource: "sleep",
    } as unknown as WhoopQueueMessage);

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.isSyncConnectionCurrent).toHaveBeenCalledWith(42, "stale-connection-id");
    expect(client.getCollection).not.toHaveBeenCalled();
    expect(repository.upsertSourceRecord).not.toHaveBeenCalled();
    expect(repository.upsertCheckpoint).not.toHaveBeenCalled();
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });

  it("acknowledges a superseded reconciliation generation before provider access", async () => {
    const { client, dependencies, env, repository } = createHarness();
    repository.isReconciliationCurrent.mockResolvedValue(false);
    const batch = batchOf({
      kind: "reconcile",
      whoopUserId: 42,
      resource: "sleep",
    });

    await handleWhoopQueue(batch, env, dependencies);

    expect(repository.isReconciliationCurrent).toHaveBeenCalledWith(42, CONNECTION_ID, 7);
    expect(client.getCollection).not.toHaveBeenCalled();
    expect(repository.upsertSourceRecord).not.toHaveBeenCalled();
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });

  it("stops delayed work when the lifecycle fence is lost after the provider fetch", async () => {
    const { client, dependencies, env, repository } = createHarness();
    client.getCollection.mockResolvedValue({ records: [SLEEP] });
    repository.upsertSourceRecord.mockResolvedValue(false);
    const batch = batchOf({
      kind: "backfill",
      whoopUserId: 42,
      resource: "sleep",
    });

    await handleWhoopQueue(batch, env, dependencies);

    expect(client.getCollection).toHaveBeenCalledTimes(1);
    expect(repository.upsertSourceRecord).toHaveBeenCalledTimes(1);
    expect(repository.upsertCheckpoint).not.toHaveBeenCalled();
    expect(repository.activateCompletedBackfill).not.toHaveBeenCalled();
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });
});
