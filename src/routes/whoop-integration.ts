import { Hono } from "hono";
import { z } from "zod";
import { createOAuthState, encryptWhoopToken, hashOAuthState } from "../services/whoop/crypto";
import { WhoopClient, type WhoopTokenResponse } from "../services/whoop/client";
import {
  type CurrentWhoopConnection,
  type SyncProgressProjection,
  WhoopRepository,
} from "../services/whoop/repository";
import {
  authSecurity,
  errorResponses,
  errorSchema,
  okSchema,
  openApiResponse,
  openApiJsonRequestBody,
  okResponses,
  openApiRegistry,
  whoopAuthorizationUrlResponseSchema,
  whoopIntegrationStatusResponseSchema,
} from "../schemas/openapi";
import type { Env } from "../types/env";
import { WHOOP_SCOPES, type WhoopQueueMessage, type WhoopResource } from "../types/whoop";
import { enqueueReconciliation } from "../services/whoop/sync";
import { whoopWebhookSchema } from "../schemas/whoop";

const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const OAUTH_STATE_LIFETIME_MILLISECONDS = 10 * 60 * 1000;
const WEBHOOK_MAX_SKEW_MILLISECONDS = 5 * 60 * 1000;
const INITIAL_RESOURCES: readonly WhoopResource[] = [
  "profile", "body_measurement", "cycle", "recovery", "sleep", "workout",
];

interface IntegrationRepository {
  createOAuthState(stateHash: string, createdAt: string, expiresAt: string): Promise<void>;
  consumeOAuthState(stateHash: string, consumedAt: string): Promise<boolean>;
  getCurrentConnection(): Promise<CurrentWhoopConnection | null>;
  getSyncProgress(whoopUserId: number): Promise<SyncProgressProjection[]>;
  beginReconciliation(
    whoopUserId: number,
    connectionId: string,
    begunAt: string,
  ): Promise<number | null>;
  getPendingRecoveryCycleIds(whoopUserId: number, limit?: number): Promise<number[]>;
  claimAndUpsertConnection(input: Parameters<WhoopRepository["claimAndUpsertConnection"]>[0]): Promise<number | null>;
  markInitialBackfillQueued(
    whoopUserId: number,
    connectionId: string,
    credentialVersion: number,
    queuedAt: string,
  ): Promise<boolean>;
  recordWebhookEvent(input: Parameters<WhoopRepository["recordWebhookEvent"]>[0]): Promise<boolean>;
  getWebhookEventStatus(
    traceId: string,
    whoopUserId: number,
    connectionId: string,
  ): ReturnType<WhoopRepository["getWebhookEventStatus"]>;
  markWebhookQueued(traceId: string, whoopUserId: number, connectionId: string): Promise<boolean>;
  withWhoopAccessToken<T>(
    whoopUserId: number,
    request: (accessToken: string, credentialVersion: number) => Promise<T>,
    refresh: (refreshToken: string, options: { signal: AbortSignal }) => Promise<WhoopTokenResponse>,
  ): Promise<T>;
  disconnect(whoopUserId: number, credentialVersion: number, disconnectedAt: string): Promise<boolean>;
  deleteLocalData(whoopUserId: number, credentialVersion: number): Promise<boolean>;
}

interface IntegrationClient {
  exchangeAuthorizationCode(code: string): ReturnType<WhoopClient["exchangeAuthorizationCode"]>;
  getProfile(): ReturnType<WhoopClient["getProfile"]>;
  revokeAccess(accessToken: string): ReturnType<WhoopClient["revokeAccess"]>;
  refreshToken(refreshToken: string, options?: { signal?: AbortSignal }): ReturnType<WhoopClient["refreshToken"]>;
}

export interface WhoopIntegrationDependencies {
  repository?: IntegrationRepository;
  clientFactory?: (env: Env, accessToken: string) => IntegrationClient;
  now?: () => Date;
}

const configured = (env: Env): boolean => {
  if (!env.DB) return false;
  if (!env.WHOOP_SYNC_QUEUE
    || typeof env.WHOOP_SYNC_QUEUE.send !== "function"
    || typeof env.WHOOP_SYNC_QUEUE.sendBatch !== "function") return false;
  const requiredStrings = [
    env.WHOOP_CLIENT_ID,
    env.WHOOP_CLIENT_SECRET,
    env.WHOOP_TOKEN_ENCRYPTION_KEY,
    env.WHOOP_REDIRECT_URI,
    env.OS_BASE_URL,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) return false;
  try {
    return new URL(env.WHOOP_REDIRECT_URI).protocol === "https:"
      && new URL(env.OS_BASE_URL).protocol === "https:";
  } catch {
    return false;
  }
};

const resultRedirect = (env: Env, result: "connected" | "failed"): string =>
  new URL(`/health/source?result=${result}`, env.OS_BASE_URL).toString();

const connectionCanSync = (connection: CurrentWhoopConnection | null): connection is CurrentWhoopConnection =>
  connection !== null && (connection.status === "active" || connection.status === "backfilling");

const backfillMessagesFor = (
  whoopUserId: number,
  connectionId: string,
): WhoopQueueMessage[] => INITIAL_RESOURCES.map((resource) => ({
  kind: "backfill",
  whoopUserId,
  connectionId,
  resource,
}));

const decodeCanonicalBase64 = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return new Uint8Array();
  }
  try {
    const decoded = atob(value);
    if (btoa(decoded) !== value) return new Uint8Array();
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
};

const constantTimeBytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length;
  const paddedLength = Math.max(left.length, right.length);
  for (let index = 0; index < paddedLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

const validWebhookSignature = async (
  secret: string,
  timestampHeader: string,
  signatureHeader: string,
  rawBody: string,
  now: Date,
): Promise<boolean> => {
  if (!/^(?:0|[1-9][0-9]*)$/.test(timestampHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp)
    || Math.abs(now.getTime() - timestamp) > WEBHOOK_MAX_SKEW_MILLISECONDS) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(timestampHeader + rawBody),
  ));
  return constantTimeBytesEqual(decodeCanonicalBase64(signatureHeader), expected);
};

export function createWhoopIntegrationRoute(dependencies: WhoopIntegrationDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const now = dependencies.now ?? (() => new Date());
  const repositoryFor = (env: Env): IntegrationRepository => dependencies.repository
    ?? new WhoopRepository(env.DB, env.WHOOP_TOKEN_ENCRYPTION_KEY);
  const clientFor = (env: Env, accessToken: string): IntegrationClient => dependencies.clientFactory?.(env, accessToken)
    ?? new WhoopClient(env, accessToken);
  const revokeIssuedAccessToken = async (env: Env, accessToken: string): Promise<void> => {
    try {
      await clientFor(env, accessToken).revokeAccess(accessToken);
    } catch {
      // A rejected connection claim must not expose a provider revocation failure.
    }
  };
  const callbackFailure = (env: Env) => new Response(null, {
    status: 302,
    headers: { location: resultRedirect(env, "failed") },
  });

  app.get("/v1/integrations/whoop", async (c) => {
    const repository = repositoryFor(c.env);
    const connection = await repository.getCurrentConnection();
    if (!connection) return c.json({ status: "not_connected", progress: [] });
    const progress = await repository.getSyncProgress(connection.whoopUserId);
    const {
      whoopUserId: _whoopUserId,
      connectionId: _connectionId,
      credentialVersion: _credentialVersion,
      reconcileGeneration: _reconcileGeneration,
      ...status
    } = connection;
    return c.json({ ...status, progress });
  });

  app.post("/v1/integrations/whoop/connect", async (c) => {
    if (!configured(c.env)) return c.json({ error: "WHOOP integration is not configured" }, 503);
    const repository = repositoryFor(c.env);
    const createdAt = now();
    const state = await createOAuthState();
    const stateHash = await hashOAuthState(state);
    await repository.createOAuthState(
      stateHash,
      createdAt.toISOString(),
      new Date(createdAt.getTime() + OAUTH_STATE_LIFETIME_MILLISECONDS).toISOString(),
    );
    const url = new URL(WHOOP_AUTHORIZE_URL);
    url.searchParams.set("client_id", c.env.WHOOP_CLIENT_ID);
    url.searchParams.set("redirect_uri", c.env.WHOOP_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", WHOOP_SCOPES.join(" "));
    url.searchParams.set("state", state);
    return c.json({ authorization_url: url.toString() });
  });

  app.get("/integrations/whoop/callback", async (c) => {
    if (!configured(c.env)) return callbackFailure(c.env);
    const state = c.req.query("state");
    if (!state) return callbackFailure(c.env);
    let issuedAccessToken: string | null = null;
    let claimAttempted = false;
    try {
      const repository = repositoryFor(c.env);
      const consumed = await repository.consumeOAuthState(await hashOAuthState(state), now().toISOString());
      if (!consumed) return callbackFailure(c.env);
      const code = c.req.query("code");
      if (!code) return callbackFailure(c.env);
      const unauthenticatedClient = clientFor(c.env, "");
      const tokens = await unauthenticatedClient.exchangeAuthorizationCode(code);
      issuedAccessToken = tokens.access_token;
      const authenticatedClient = clientFor(c.env, tokens.access_token);
      const profile = await authenticatedClient.getProfile();
      const connectedAt = now();
      const connectionId = crypto.randomUUID();
      const [accessToken, refreshToken] = await Promise.all([
        encryptWhoopToken(c.env.WHOOP_TOKEN_ENCRYPTION_KEY, profile.user_id, "access", tokens.access_token),
        encryptWhoopToken(c.env.WHOOP_TOKEN_ENCRYPTION_KEY, profile.user_id, "refresh", tokens.refresh_token),
      ]);
      claimAttempted = true;
      const credentialVersion = await repository.claimAndUpsertConnection({
        whoopUserId: profile.user_id,
        connectionId,
        status: "backfilling",
        accessToken,
        accessTokenExpiresAt: new Date(connectedAt.getTime() + tokens.expires_in * 1000).toISOString(),
        refreshToken,
        grantedScopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? WHOOP_SCOPES,
        connectedAt: connectedAt.toISOString(),
        initialBackfillPending: true,
      });
      if (credentialVersion === null) {
        await revokeIssuedAccessToken(c.env, tokens.access_token);
        return callbackFailure(c.env);
      }
      await c.env.WHOOP_SYNC_QUEUE.sendBatch(
        backfillMessagesFor(profile.user_id, connectionId).map((body) => ({ body })),
      );
      const markedQueued = await repository.markInitialBackfillQueued(
        profile.user_id,
        connectionId,
        credentialVersion,
        now().toISOString(),
      );
      if (!markedQueued) return callbackFailure(c.env);
      return c.redirect(resultRedirect(c.env, "connected"));
    } catch {
      if (issuedAccessToken !== null && !claimAttempted) {
        await revokeIssuedAccessToken(c.env, issuedAccessToken);
      }
      return callbackFailure(c.env);
    }
  });

  app.post("/integrations/whoop/webhook", async (c) => {
    const signature = c.req.header("X-WHOOP-Signature");
    const timestamp = c.req.header("X-WHOOP-Signature-Timestamp");
    if (!signature || !timestamp || typeof c.env.WHOOP_CLIENT_SECRET !== "string"
      || c.env.WHOOP_CLIENT_SECRET.length === 0) {
      return c.json({ error: "Invalid WHOOP webhook signature" }, 401);
    }
    const rawBody = await c.req.raw.text();
    if (!await validWebhookSignature(c.env.WHOOP_CLIENT_SECRET, timestamp, signature, rawBody, now())) {
      return c.json({ error: "Invalid WHOOP webhook signature" }, 401);
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid WHOOP webhook payload" }, 400);
    }
    const parsed = whoopWebhookSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "Invalid WHOOP webhook payload" }, 400);

    const repository = repositoryFor(c.env);
    const connection = await repository.getCurrentConnection();
    if (!connectionCanSync(connection) || connection.whoopUserId !== parsed.data.user_id) {
      return c.body(null, 204);
    }
    const receipt = {
      traceId: parsed.data.trace_id,
      whoopUserId: parsed.data.user_id,
      connectionId: connection.connectionId,
      resourceId: parsed.data.id,
      eventType: parsed.data.type,
      receivedAt: now().toISOString(),
    };
    const inserted = await repository.recordWebhookEvent(receipt);
    if (!inserted) {
      const status = await repository.getWebhookEventStatus(
        receipt.traceId,
        receipt.whoopUserId,
        receipt.connectionId,
      );
      if (status !== "received") return c.body(null, 204);
    }
    try {
      await c.env.WHOOP_SYNC_QUEUE.send({
        kind: "webhook",
        traceId: receipt.traceId,
        whoopUserId: receipt.whoopUserId,
        connectionId: receipt.connectionId,
        resourceId: receipt.resourceId,
        eventType: receipt.eventType,
      });
    } catch {
      return c.json({ error: "WHOOP webhook queue unavailable" }, 503);
    }
    let markedQueued: boolean;
    try {
      markedQueued = await repository.markWebhookQueued(
        receipt.traceId,
        receipt.whoopUserId,
        receipt.connectionId,
      );
    } catch {
      return c.json({ error: "WHOOP webhook queue unavailable" }, 503);
    }
    if (!markedQueued) {
      const status = await repository.getWebhookEventStatus(
        receipt.traceId,
        receipt.whoopUserId,
        receipt.connectionId,
      );
      if (status === "received") {
        return c.json({ error: "WHOOP webhook queue unavailable" }, 503);
      }
    }
    return c.body(null, 204);
  });

  app.post("/v1/integrations/whoop/sync", async (c) => {
    if (!configured(c.env)) return c.json({ error: "WHOOP integration is not configured" }, 503);
    const repository = repositoryFor(c.env);
    const connection = await repository.getCurrentConnection();
    if (!connectionCanSync(connection)) return c.json({ error: "WHOOP is not connected" }, 409);
    await enqueueReconciliation(c.env, connection.whoopUserId, "manual", {
      repository,
      now,
      expectedConnectionId: connection.connectionId,
      requireActiveConnection: false,
    });
    return c.json({ ok: true }, 202);
  });

  app.delete("/v1/integrations/whoop", async (c) => {
    if (!configured(c.env)) return c.json({ error: "WHOOP integration is not configured" }, 503);
    const repository = repositoryFor(c.env);
    const connection = await repository.getCurrentConnection();
    if (!connectionCanSync(connection)) return c.json({ error: "WHOOP is not connected" }, 409);
    try {
      let revokedCredentialVersion: number | null = null;
      await repository.withWhoopAccessToken(
        connection.whoopUserId,
        async (accessToken, credentialVersion) => {
          await clientFor(c.env, accessToken).revokeAccess(accessToken);
          revokedCredentialVersion = credentialVersion;
        },
        (refreshToken, options) => clientFor(c.env, "").refreshToken(refreshToken, options),
      );
      if (revokedCredentialVersion === null) return c.json({ error: "WHOOP connection changed before disconnect" }, 409);
      const disconnected = await repository.disconnect(
        connection.whoopUserId,
        revokedCredentialVersion,
        now().toISOString(),
      );
      if (!disconnected) return c.json({ error: "WHOOP connection changed before disconnect" }, 409);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "WHOOP disconnect failed" }, 502);
    }
  });

  app.delete("/v1/integrations/whoop/data", async (c) => {
    const repository = repositoryFor(c.env);
    const connection = await repository.getCurrentConnection();
    if (!connection || connection.status !== "disconnected") {
      return c.json({ error: "Disconnect WHOOP before deleting local data" }, 409);
    }
    const deleted = await repository.deleteLocalData(connection.whoopUserId, connection.credentialVersion);
    if (!deleted) return c.json({ error: "WHOOP connection changed before data deletion" }, 409);
    return c.json({ ok: true });
  });

  return app;
}

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/integrations/whoop",
  summary: "Get WHOOP connection and sync status",
  security: authSecurity,
  responses: okResponses(whoopIntegrationStatusResponseSchema),
});

const whoopWebhookHeadersSchema = z.object({
  "X-WHOOP-Signature": z.string(),
  "X-WHOOP-Signature-Timestamp": z.string(),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/integrations/whoop/webhook",
  summary: "Receive a signed WHOOP webhook",
  request: {
    headers: whoopWebhookHeadersSchema,
    body: openApiJsonRequestBody(whoopWebhookSchema),
  },
  responses: {
    204: { description: "Webhook accepted" },
    400: openApiResponse(errorSchema, "Invalid webhook payload"),
    401: openApiResponse(errorSchema, "Invalid webhook signature"),
    503: openApiResponse(errorSchema, "Webhook queue unavailable"),
  },
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/integrations/whoop/connect",
  summary: "Create a WHOOP authorization URL",
  security: authSecurity,
  responses: okResponses(whoopAuthorizationUrlResponseSchema),
});

openApiRegistry.registerPath({
  method: "post",
  path: "/v1/integrations/whoop/sync",
  summary: "Queue WHOOP reconciliation",
  security: authSecurity,
  responses: {
    202: openApiResponse(okSchema, "Reconciliation queued"),
    ...errorResponses,
  },
});

for (const [method, path, summary] of [
  ["delete", "/v1/integrations/whoop", "Revoke WHOOP access and disconnect"],
  ["delete", "/v1/integrations/whoop/data", "Delete disconnected local WHOOP data"],
] as const) {
  openApiRegistry.registerPath({
    method,
    path,
    summary,
    security: authSecurity,
    responses: okResponses(okSchema),
  });
}

openApiRegistry.registerPath({
  method: "get",
  path: "/integrations/whoop/callback",
  summary: "Complete WHOOP OAuth authorization",
  responses: {
    302: { description: "Fixed OS connection result redirect" },
  },
});

export default createWhoopIntegrationRoute();
