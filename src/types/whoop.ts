export const WHOOP_SCOPES = [
  "offline",
  "read:profile",
  "read:body_measurement",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
] as const;

export type WhoopScope = (typeof WHOOP_SCOPES)[number];

export type WhoopConnectionStatus =
  | "not_connected"
  | "connecting"
  | "backfilling"
  | "active"
  | "needs_reauth"
  | "disconnected"
  | "error";

export type WhoopResource =
  | "profile"
  | "body_measurement"
  | "cycle"
  | "recovery"
  | "sleep"
  | "workout";

export type WhoopWebhookEventType =
  | "workout.updated"
  | "workout.deleted"
  | "sleep.updated"
  | "sleep.deleted"
  | "recovery.updated"
  | "recovery.deleted";

export interface WhoopWebhookEvent {
  user_id: number;
  id: string;
  type: WhoopWebhookEventType;
  trace_id: string;
}

export type WhoopQueueMessage =
  | {
      kind: "backfill";
      whoopUserId: number;
      connectionId: string;
      resource: WhoopResource;
      nextToken?: string;
      pageCount?: number;
      recordCount?: number;
      trigger?: string;
    }
  | {
      kind: "reconcile";
      whoopUserId: number;
      connectionId: string;
      reconcileGeneration: number;
      reconcileRunId: string;
      resource: WhoopResource;
      nextToken?: string;
      windowStart?: string;
      windowEnd?: string;
      pageCount?: number;
      recordCount?: number;
      recoveryCycleId?: number;
      trigger?: string;
    }
  | {
      kind: "webhook";
      traceId: string;
      whoopUserId: number;
      connectionId: string;
      resourceId: string;
      eventType: WhoopWebhookEventType;
    };
