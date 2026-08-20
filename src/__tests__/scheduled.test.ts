import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/env";
import { handleScheduled, runRefreshJob } from "../scheduled";
import type { WhoopQueueMessage } from "../types/whoop";
import { CONNECTION_ID, ENV, NOW } from "./whoop/fixtures";

const RESOURCES = ["profile", "body_measurement", "cycle", "recovery", "sleep", "workout"] as const;
const SCHEDULED_EVENT = {} as ScheduledEvent;

function createDb() {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          calls.push({ sql, bindings });
          return {
            run: vi.fn().mockResolvedValue({ success: true }),
          };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, calls };
}

function createScheduledDependencies() {
  const repository = {
    getPendingInitialBackfills: vi.fn().mockResolvedValue([]),
    markInitialBackfillQueued: vi.fn().mockResolvedValue(true),
    getCurrentConnection: vi.fn().mockResolvedValue(null),
    withWhoopAccessToken: vi.fn(async (_userId, request) => request("fixture-access-token", 3)),
  };
  const enqueueReconciliation = vi.fn().mockResolvedValue(undefined);
  const refreshJobs = {
    lanyard: vi.fn().mockResolvedValue(undefined),
    wakatime: vi.fn().mockResolvedValue(undefined),
    github: vi.fn().mockResolvedValue(undefined),
  };
  return {
    dependencies: {
      repository,
      enqueueReconciliation,
      refreshJobs,
      now: () => new Date(NOW),
    },
    enqueueReconciliation,
    refreshJobs,
    repository,
  };
}

async function runScheduled(
  env: Env,
  dependencies: ReturnType<typeof createScheduledDependencies>["dependencies"],
) {
  const scheduled = handleScheduled as unknown as (
    event: ScheduledEvent,
    bindings: Env,
    injected: typeof dependencies,
  ) => Promise<void>;
  await scheduled(SCHEDULED_EVENT, env, dependencies);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduled refresh health", () => {
  it("records start and success for a completed job", async () => {
    const { db, calls } = createDb();
    const env = { DB: db } as Env;

    await runRefreshJob(env, "github", async () => {});

    expect(calls).toHaveLength(2);
    expect(calls[0].bindings[0]).toBe("github");
    expect(calls[0].sql).toContain("last_started_at");
    expect(calls[1].bindings[0]).toBe("github");
    expect(calls[1].sql).toContain("last_success_at");
  });

  it("records failure and rethrows so allSettled can log the failed job", async () => {
    const { db, calls } = createDb();
    const env = { DB: db } as Env;
    const error = new Error("rate limited");

    await expect(
      runRefreshJob(env, "wakatime", async () => {
        throw error;
      })
    ).rejects.toThrow("rate limited");

    expect(calls).toHaveLength(2);
    expect(calls[1].bindings[0]).toBe("wakatime");
    expect(calls[1].bindings[2]).toContain("rate limited");
    expect(calls[1].sql).toContain("consecutive_failures + 1");
  });

  it("replays each durable initial backfill as one exact six-message batch before clearing intent", async () => {
    const { db } = createDb();
    const queue = { send: vi.fn(), sendBatch: vi.fn().mockResolvedValue(undefined) };
    const env = { ...ENV, DB: db, WHOOP_SYNC_QUEUE: queue as unknown as Queue<WhoopQueueMessage> };
    const { dependencies, repository } = createScheduledDependencies();
    repository.getPendingInitialBackfills.mockResolvedValue([{
      whoopUserId: 42,
      connectionId: "connection-3",
      credentialVersion: 3,
    }]);

    await runScheduled(env, dependencies);

    expect(queue.sendBatch).toHaveBeenCalledWith(RESOURCES.map((resource) => ({
      body: {
        kind: "backfill",
        whoopUserId: 42,
        connectionId: "connection-3",
        resource,
      },
    })));
    expect(repository.markInitialBackfillQueued).toHaveBeenCalledWith(
      42,
      "connection-3",
      3,
      NOW,
    );
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("keeps ambiguous backfill intent pending and replays the same batch on the next schedule", async () => {
    const { db } = createDb();
    const queue = {
      send: vi.fn(),
      sendBatch: vi.fn()
        .mockRejectedValueOnce(new Error("queue publication unknown"))
        .mockResolvedValueOnce(undefined),
    };
    const env = { ...ENV, DB: db, WHOOP_SYNC_QUEUE: queue as unknown as Queue<WhoopQueueMessage> };
    const { dependencies, repository } = createScheduledDependencies();
    repository.getPendingInitialBackfills.mockResolvedValue([{
      whoopUserId: 42,
      connectionId: "connection-3",
      credentialVersion: 3,
    }]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runScheduled(env, dependencies);
    expect(repository.markInitialBackfillQueued).not.toHaveBeenCalled();

    await runScheduled(env, dependencies);

    expect(queue.sendBatch).toHaveBeenCalledTimes(2);
    expect(queue.sendBatch.mock.calls[1][0]).toEqual(queue.sendBatch.mock.calls[0][0]);
    expect(repository.markInitialBackfillQueued).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("delegates active connections to the canonical scheduled reconciliation producer", async () => {
    const { db } = createDb();
    const queue = { send: vi.fn(), sendBatch: vi.fn() };
    const env = { ...ENV, DB: db, WHOOP_SYNC_QUEUE: queue as unknown as Queue<WhoopQueueMessage> };
    const { dependencies, enqueueReconciliation, repository } = createScheduledDependencies();
    repository.getCurrentConnection.mockResolvedValue({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      credentialVersion: 3,
      reconcileGeneration: 7,
      status: "active",
    });

    await runScheduled(env, dependencies);

    expect(enqueueReconciliation).toHaveBeenCalledWith(
      env,
      42,
      "scheduled",
      { repository, now: dependencies.now },
    );
    expect(queue.send).not.toHaveBeenCalled();
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it("checks token expiry through the serialized refresh path without making an access-token request", async () => {
    const { db } = createDb();
    const env = { ...ENV, DB: db };
    const { dependencies, enqueueReconciliation, repository } = createScheduledDependencies();
    repository.getCurrentConnection.mockResolvedValue({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      credentialVersion: 3,
      reconcileGeneration: 7,
      status: "active",
    });
    repository.withWhoopAccessToken.mockImplementation(async (_userId, request) => {
      const result = await request("must-not-leave-local-callback", 3);
      expect(result).toBeUndefined();
      return result;
    });

    await runScheduled(env, dependencies);

    expect(repository.withWhoopAccessToken).toHaveBeenCalledWith(
      42,
      expect.any(Function),
      expect.any(Function),
      {
        expectedConnectionId: CONNECTION_ID,
        refreshBeforeExpirationMilliseconds: 5 * 60 * 1000,
      },
    );
    expect(repository.withWhoopAccessToken.mock.invocationCallOrder[0])
      .toBeLessThan(enqueueReconciliation.mock.invocationCallOrder[0]);
  });

  it("starts reconciliation only for active connections", async () => {
    const { db } = createDb();
    const env = { ...ENV, DB: db };
    const { dependencies, enqueueReconciliation, repository } = createScheduledDependencies();

    for (const status of ["active", "backfilling", "disconnected"] as const) {
      repository.getCurrentConnection.mockResolvedValueOnce({
        whoopUserId: 42,
        connectionId: CONNECTION_ID,
        credentialVersion: 3,
        reconcileGeneration: 7,
        status,
      });
      await runScheduled(env, dependencies);
    }

    expect(enqueueReconciliation).toHaveBeenCalledTimes(1);
  });

  it("keeps WHOOP and every existing scheduled job isolated through allSettled", async () => {
    const { db, calls } = createDb();
    const env = { ...ENV, DB: db };
    const { dependencies, enqueueReconciliation, refreshJobs, repository } = createScheduledDependencies();
    refreshJobs.lanyard.mockRejectedValue(new Error("lanyard unavailable"));
    repository.getCurrentConnection.mockResolvedValue({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      credentialVersion: 3,
      reconcileGeneration: 7,
      status: "active",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runScheduled(env, dependencies);

    expect(refreshJobs.lanyard).toHaveBeenCalledTimes(1);
    expect(refreshJobs.wakatime).toHaveBeenCalledTimes(1);
    expect(refreshJobs.github).toHaveBeenCalledTimes(1);
    expect(enqueueReconciliation).toHaveBeenCalledTimes(1);
    expect(calls.filter(({ bindings }) => bindings[0] === "lanyard")).toHaveLength(2);
    expect(calls.filter(({ bindings }) => bindings[0] === "whoop")).toHaveLength(2);
    error.mockRestore();
  });
});
