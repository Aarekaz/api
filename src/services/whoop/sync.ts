import type { Env } from "../../types/env";
import type {
  WhoopQueueMessage,
  WhoopResource,
  WhoopWebhookEventType,
} from "../../types/whoop";
import { WhoopClient, WhoopRequestError } from "./client";
import { WhoopRepository, WhoopStaleConnectionError } from "./repository";

const RECONCILIATION_WINDOW_MILLISECONDS = 14 * 24 * 60 * 60 * 1000;

class WhoopPostCheckpointError extends Error {
  constructor() {
    super("WHOOP post-checkpoint operation failed");
  }
}

type SyncClient = Pick<WhoopClient,
  | "getProfile"
  | "getBodyMeasurements"
  | "getCollection"
  | "getCycle"
  | "getRecovery"
  | "getSleep"
  | "getWorkout"
>;

type SyncRepository = Pick<WhoopRepository,
  | "upsertSourceRecord"
  | "tombstoneSourceRecord"
  | "upsertCheckpoint"
  | "recordReconciliationSeen"
  | "cleanupReconciliationSeen"
  | "finalizeReconciliation"
  | "beginReconciliation"
  | "getPendingRecoveryCycleIds"
  | "markWebhookProcessed"
  | "markWebhookFailed"
  | "getCurrentConnection"
  | "isSyncConnectionCurrent"
  | "isReconciliationCurrent"
  | "activateCompletedBackfill"
>;

type ReconciliationPublisherRepository = Pick<WhoopRepository,
  | "beginReconciliation"
  | "getCurrentConnection"
  | "getPendingRecoveryCycleIds"
>;

export interface WhoopSyncDependencies {
  repository?: SyncRepository;
  client?: SyncClient;
  clientFactory?: (env: Env, accessToken: string) => SyncClient;
  now?: () => Date;
}

export interface EnqueueReconciliationDependencies {
  repository?: ReconciliationPublisherRepository;
  now?: () => Date;
}

export interface ProcessWebhookInput {
  eventType: WhoopWebhookEventType;
  resourceId: string;
  whoopUserId: number;
  connectionId: string;
}

const requireCurrentWrite = (written: boolean | void): void => {
  if (written === false) throw new WhoopStaleConnectionError();
};

const isCollectionResource = (
  resource: WhoopResource,
): resource is "cycle" | "recovery" | "sleep" | "workout" =>
  resource === "cycle" || resource === "recovery" || resource === "sleep" || resource === "workout";

const RECONCILIATION_RESOURCES = [
  "profile", "body_measurement", "cycle", "recovery", "sleep", "workout",
] as const;

const checkpointIdentity = (body: Exclude<WhoopQueueMessage, { kind: "webhook" }>) => body.kind === "backfill"
  ? { reconcileGeneration: 0, syncRunId: "initial-backfill", targetId: "" }
  : {
      reconcileGeneration: body.reconcileGeneration,
      syncRunId: body.reconcileRunId,
      targetId: body.recoveryCycleId === undefined ? "" : `recovery-cycle:${body.recoveryCycleId}`,
    };

const providerIdFor = (
  resource: "cycle" | "recovery" | "sleep" | "workout",
  record: Record<string, unknown>,
): string | number => {
  const providerId = resource === "recovery" ? record.sleep_id : record.id;
  if (typeof providerId !== "string" && typeof providerId !== "number") {
    throw new Error("WHOOP source identity is unavailable");
  }
  return providerId;
};

export async function enqueueReconciliation(
  env: Env,
  whoopUserId: number,
  trigger: string,
  dependencies: EnqueueReconciliationDependencies = {},
): Promise<void> {
  const repository = dependencies.repository
    ?? new WhoopRepository(env.DB, env.WHOOP_TOKEN_ENCRYPTION_KEY);
  const now = (dependencies.now ?? (() => new Date()))();
  const connection = await repository.getCurrentConnection();
  if (!connection
    || connection.whoopUserId !== whoopUserId
    || (connection.status !== "active" && connection.status !== "backfilling")) {
    throw new Error("WHOOP connection is not available for reconciliation");
  }
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - RECONCILIATION_WINDOW_MILLISECONDS).toISOString();
  const reconcileRunId = crypto.randomUUID();
  const reconcileGeneration = await repository.beginReconciliation(
    whoopUserId,
    connection.connectionId,
    windowEnd,
  );
  if (reconcileGeneration === null) {
    throw new Error("WHOOP connection changed before reconciliation began");
  }
  const pendingRecoveryCycleIds = await repository.getPendingRecoveryCycleIds(whoopUserId, 25);
  const messages: WhoopQueueMessage[] = RECONCILIATION_RESOURCES.map((resource) => ({
    kind: "reconcile",
    whoopUserId,
    connectionId: connection.connectionId,
    reconcileGeneration,
    reconcileRunId,
    resource,
    ...(isCollectionResource(resource) ? { windowStart, windowEnd } : {}),
    trigger,
  }));
  messages.push(...pendingRecoveryCycleIds.map((recoveryCycleId) => ({
    kind: "reconcile" as const,
    whoopUserId,
    connectionId: connection.connectionId,
    reconcileGeneration,
    reconcileRunId,
    resource: "recovery" as const,
    recoveryCycleId,
    trigger,
  })));
  await env.WHOOP_SYNC_QUEUE.sendBatch(messages.map((body) => ({ body })));
}

export async function processWebhook(
  input: ProcessWebhookInput,
  dependencies: WhoopSyncDependencies,
): Promise<void> {
  if (!dependencies.repository) {
    throw new Error("WHOOP webhook processing dependencies are unavailable");
  }
  const syncedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  if (input.eventType.endsWith(".deleted")) {
    const resource = input.eventType.split(".", 1)[0] as "workout" | "sleep" | "recovery";
    requireCurrentWrite(await dependencies.repository.tombstoneSourceRecord(
      resource,
      input.resourceId,
      syncedAt,
      { whoopUserId: input.whoopUserId, connectionId: input.connectionId },
    ));
    return;
  }
  if (!dependencies.client) {
    throw new Error("WHOOP webhook processing dependencies are unavailable");
  }
  if (input.eventType === "recovery.updated") {
    const sleep = await dependencies.client.getSleep(input.resourceId);
    const recovery = await dependencies.client.getRecovery(sleep.cycle_id);
    requireCurrentWrite(await dependencies.repository.upsertSourceRecord("recovery", recovery, {
      tombstonePolicy: "preserve",
      syncedAt,
      whoopUserId: input.whoopUserId,
      connectionId: input.connectionId,
    }));
  }
  if (input.eventType === "workout.updated") {
    const workout = await dependencies.client.getWorkout(input.resourceId);
    requireCurrentWrite(await dependencies.repository.upsertSourceRecord("workout", workout, {
      tombstonePolicy: "preserve",
      syncedAt,
      whoopUserId: input.whoopUserId,
      connectionId: input.connectionId,
    }));
  }
  if (input.eventType === "sleep.updated") {
    const sleep = await dependencies.client.getSleep(input.resourceId);
    requireCurrentWrite(await dependencies.repository.upsertSourceRecord("sleep", sleep, {
      tombstonePolicy: "preserve",
      syncedAt,
      whoopUserId: input.whoopUserId,
      connectionId: input.connectionId,
    }));
  }
}

export async function handleWhoopQueue(
  batch: MessageBatch<WhoopQueueMessage>,
  env: Env,
  dependencies: WhoopSyncDependencies = {},
): Promise<void> {
  const repository = dependencies.repository
    ?? new WhoopRepository(env.DB, env.WHOOP_TOKEN_ENCRYPTION_KEY);
  const now = dependencies.now ?? (() => new Date());

  for (const message of batch.messages) {
    const body = message.body;
    try {
    const currentConnection = body.kind === "reconcile"
      ? await repository.isReconciliationCurrent(
          body.whoopUserId,
          body.connectionId,
          body.reconcileGeneration,
        )
      : await repository.isSyncConnectionCurrent(body.whoopUserId, body.connectionId);
    if (!currentConnection) {
      message.ack();
      continue;
    }
    if (body.kind === "webhook") {
      const processEvent = async (client: SyncClient): Promise<void> => processWebhook({
        eventType: body.eventType,
        resourceId: body.resourceId,
        whoopUserId: body.whoopUserId,
        connectionId: body.connectionId,
      }, { repository, client, now });
      if (body.eventType.endsWith(".deleted")) {
        await processWebhook({
          eventType: body.eventType,
          resourceId: body.resourceId,
          whoopUserId: body.whoopUserId,
          connectionId: body.connectionId,
        }, { repository, now });
      } else if (dependencies.client) {
        await processEvent(dependencies.client);
      } else {
        const tokenRepository = repository as WhoopRepository;
        await tokenRepository.withWhoopAccessToken(
          body.whoopUserId,
          (accessToken) => processEvent(
            dependencies.clientFactory?.(env, accessToken) ?? new WhoopClient(env, accessToken),
          ),
          (refreshToken, options) => new WhoopClient(env, "").refreshToken(refreshToken, options),
          { expectedConnectionId: body.connectionId },
        );
      }
      requireCurrentWrite(await repository.markWebhookProcessed(
        body.traceId,
        body.whoopUserId,
        body.connectionId,
        now().toISOString(),
      ));
      message.ack();
      continue;
    }
    const resource = body.resource;
    const windowEnd = body.kind === "reconcile"
      ? body.windowEnd ?? now().toISOString()
      : null;
    const windowStart = body.kind === "reconcile"
      ? body.windowStart ?? new Date(Date.parse(windowEnd!) - RECONCILIATION_WINDOW_MILLISECONDS).toISOString()
      : null;
    const tombstonePolicy = body.kind === "reconcile" ? "reconcile" : "preserve";
    const identity = checkpointIdentity(body);

    const processPage = async (client: SyncClient): Promise<void> => {
      if (resource === "profile" || resource === "body_measurement") {
        const record = resource === "profile"
          ? await client.getProfile()
          : { ...await client.getBodyMeasurements(), whoop_user_id: body.whoopUserId };
        const syncedAt = now().toISOString();
        requireCurrentWrite(await repository.upsertSourceRecord(resource, record, {
          tombstonePolicy,
          syncedAt,
          whoopUserId: body.whoopUserId,
          connectionId: body.connectionId,
          ...(body.kind === "reconcile"
            ? { reconcileGeneration: body.reconcileGeneration }
            : {}),
        }));
        requireCurrentWrite(await repository.upsertCheckpoint({
          whoopUserId: body.whoopUserId,
          connectionId: body.connectionId,
          resource,
          mode: body.kind,
          ...identity,
          windowStart,
          windowEnd,
          nextToken: null,
          status: "complete",
          pageCount: 1,
          recordCount: 1,
          createdAt: syncedAt,
          updatedAt: syncedAt,
          lastError: null,
        }));
        if (body.kind === "backfill") {
          try {
            await repository.activateCompletedBackfill(
              body.whoopUserId,
              body.connectionId,
              syncedAt,
            );
          } catch {
            throw new WhoopPostCheckpointError();
          }
        }
        return;
      }
      if (body.kind === "reconcile"
        && resource === "recovery"
        && body.recoveryCycleId !== undefined) {
        const record = await client.getRecovery(body.recoveryCycleId);
        const syncedAt = now().toISOString();
        requireCurrentWrite(await repository.upsertSourceRecord("recovery", record, {
          tombstonePolicy: "reconcile",
          syncedAt,
          whoopUserId: body.whoopUserId,
          connectionId: body.connectionId,
          reconcileGeneration: body.reconcileGeneration,
        }));
        requireCurrentWrite(await repository.upsertCheckpoint({
          whoopUserId: body.whoopUserId,
          connectionId: body.connectionId,
          resource,
          mode: body.kind,
          ...identity,
          windowStart,
          windowEnd,
          nextToken: null,
          status: "complete",
          pageCount: 1,
          recordCount: 1,
          createdAt: syncedAt,
          updatedAt: syncedAt,
          lastError: null,
        }));
        return;
      }
      if (!isCollectionResource(resource)) return;

      const page = await client.getCollection(resource, {
        limit: 25,
        ...(windowStart === null ? {} : { start: windowStart }),
        ...(windowEnd === null ? {} : { end: windowEnd }),
        ...(body.nextToken === undefined ? {} : { nextToken: body.nextToken }),
      });
      const syncedAt = now().toISOString();
      for (const record of page.records) {
        requireCurrentWrite(await repository.upsertSourceRecord(resource, record, {
          tombstonePolicy,
          syncedAt,
          whoopUserId: body.whoopUserId,
          connectionId: body.connectionId,
          ...(body.kind === "reconcile"
            ? { reconcileGeneration: body.reconcileGeneration }
            : {}),
        }));
        if (body.kind === "reconcile") {
          requireCurrentWrite(await repository.recordReconciliationSeen({
            whoopUserId: body.whoopUserId,
            connectionId: body.connectionId,
            reconcileGeneration: body.reconcileGeneration,
            reconcileRunId: body.reconcileRunId,
            resource,
            providerId: providerIdFor(resource, record as unknown as Record<string, unknown>),
            seenAt: syncedAt,
          }));
        }
      }
      const pageCount = (body.pageCount ?? 0) + 1;
      const recordCount = (body.recordCount ?? 0) + page.records.length;
      const checkpoint = {
        whoopUserId: body.whoopUserId,
        connectionId: body.connectionId,
        resource,
        mode: body.kind,
        ...identity,
        windowStart,
        windowEnd,
        nextToken: page.nextToken ?? null,
        status: page.nextToken === undefined ? "complete" : "running",
        pageCount,
        recordCount,
        createdAt: syncedAt,
        updatedAt: syncedAt,
        lastError: null,
      };
      if (body.kind === "reconcile" && page.nextToken === undefined) {
        requireCurrentWrite(await repository.finalizeReconciliation(checkpoint));
      } else {
        requireCurrentWrite(await repository.upsertCheckpoint(checkpoint));
      }
      if (page.nextToken !== undefined) {
        try {
          const nextMessage: WhoopQueueMessage = body.kind === "reconcile"
            ? {
                kind: "reconcile",
                whoopUserId: body.whoopUserId,
                connectionId: body.connectionId,
                reconcileGeneration: body.reconcileGeneration,
                reconcileRunId: body.reconcileRunId,
                resource,
                nextToken: page.nextToken,
                pageCount,
                recordCount,
                windowStart: windowStart!,
                windowEnd: windowEnd!,
                ...(body.trigger === undefined ? {} : { trigger: body.trigger }),
              }
            : {
                kind: "backfill",
                whoopUserId: body.whoopUserId,
                connectionId: body.connectionId,
                resource,
                nextToken: page.nextToken,
                pageCount,
                recordCount,
                ...(body.trigger === undefined ? {} : { trigger: body.trigger }),
              };
          await env.WHOOP_SYNC_QUEUE.send(nextMessage);
        } catch {
          throw new WhoopPostCheckpointError();
        }
      } else if (body.kind === "backfill") {
        try {
          await repository.activateCompletedBackfill(
            body.whoopUserId,
            body.connectionId,
            syncedAt,
          );
        } catch {
          throw new WhoopPostCheckpointError();
        }
      }
    };

    if (dependencies.client) {
      await processPage(dependencies.client);
    } else {
      const tokenRepository = repository as WhoopRepository;
      await tokenRepository.withWhoopAccessToken(
        body.whoopUserId,
        (accessToken) => processPage(
          dependencies.clientFactory?.(env, accessToken) ?? new WhoopClient(env, accessToken),
        ),
        (refreshToken, options) => new WhoopClient(env, "").refreshToken(refreshToken, options),
        { expectedConnectionId: body.connectionId },
      );
    }
    message.ack();
    } catch (error) {
      if (error instanceof WhoopStaleConnectionError) {
        message.ack();
        continue;
      }
      if (error instanceof WhoopPostCheckpointError) {
        message.retry({ delaySeconds: 30 });
        continue;
      }
      if (body.kind === "webhook") {
        const lastError = error instanceof WhoopRequestError && error.status !== undefined
          ? `WHOOP request failed with status ${error.status}`
          : "WHOOP synchronization failed";
        const permanentClientError = error instanceof WhoopRequestError
          && error.status !== undefined
          && error.status >= 400
          && error.status < 500
          && !error.retryable;
        let failureRecorded = false;
        try {
          const failureResult = await repository.markWebhookFailed(
            body.traceId,
            body.whoopUserId,
            body.connectionId,
            permanentClientError ? "error" : "retrying",
            lastError,
            now().toISOString(),
          );
          if (failureResult === false) {
            message.ack();
            continue;
          }
          failureRecorded = true;
        } catch {
          // Retrying preserves the webhook when its durable status write fails.
        }
        if (permanentClientError && failureRecorded) {
          message.ack();
          continue;
        }
        message.retry({ delaySeconds: error instanceof WhoopRequestError
          ? error.retryAfterSeconds ?? 30
          : 30 });
        continue;
      }
      const failedAt = now().toISOString();
      const lastError = error instanceof WhoopRequestError && error.status !== undefined
        ? `WHOOP request failed with status ${error.status}`
        : "WHOOP synchronization failed";
      const permanentClientError = error instanceof WhoopRequestError
        && error.status !== undefined
        && error.status >= 400
        && error.status < 500
        && !error.retryable;
      let checkpointed = false;
      try {
        const checkpointResult = await repository.upsertCheckpoint({
          whoopUserId: body.whoopUserId,
          connectionId: body.connectionId,
          resource: body.resource,
          mode: body.kind,
          ...checkpointIdentity(body),
          windowStart: body.kind === "reconcile" ? body.windowStart ?? null : null,
          windowEnd: body.kind === "reconcile" ? body.windowEnd ?? null : null,
          nextToken: body.nextToken ?? null,
          status: permanentClientError ? "error" : "retrying",
          pageCount: body.pageCount ?? 0,
          recordCount: body.recordCount ?? 0,
          createdAt: failedAt,
          updatedAt: failedAt,
          lastError,
        });
        if (checkpointResult === false) {
          message.ack();
          continue;
        }
        checkpointed = true;
      } catch {
        // Retrying the message is the durable fallback when checkpointing fails.
      }
      if (permanentClientError && checkpointed) {
        if (body.kind === "reconcile" && body.recoveryCycleId === undefined) {
          try {
            const cleaned = await repository.cleanupReconciliationSeen({
              whoopUserId: body.whoopUserId,
              connectionId: body.connectionId,
              reconcileGeneration: body.reconcileGeneration,
              reconcileRunId: body.reconcileRunId,
              resource: body.resource,
            });
            if (!cleaned) {
              message.ack();
              continue;
            }
          } catch {
            message.retry({ delaySeconds: 30 });
            continue;
          }
        }
        message.ack();
        continue;
      }
      message.retry({ delaySeconds: error instanceof WhoopRequestError
        ? error.retryAfterSeconds ?? 30
        : 30 });
    }
  }
}
