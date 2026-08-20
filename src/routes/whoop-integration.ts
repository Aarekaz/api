import { Hono } from "hono";
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
  okSchema,
  openApiResponse,
  okResponses,
  openApiRegistry,
  whoopAuthorizationUrlResponseSchema,
  whoopIntegrationStatusResponseSchema,
} from "../schemas/openapi";
import type { Env } from "../types/env";
import { WHOOP_SCOPES, type WhoopQueueMessage, type WhoopResource } from "../types/whoop";

const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const OAUTH_STATE_LIFETIME_MILLISECONDS = 10 * 60 * 1000;
const INITIAL_RESOURCES: readonly WhoopResource[] = [
  "profile", "body_measurement", "cycle", "recovery", "sleep", "workout",
];

interface IntegrationRepository {
  createOAuthState(stateHash: string, createdAt: string, expiresAt: string): Promise<void>;
  consumeOAuthState(stateHash: string, consumedAt: string): Promise<boolean>;
  getCurrentConnection(): Promise<CurrentWhoopConnection | null>;
  getSyncProgress(whoopUserId: number): Promise<SyncProgressProjection[]>;
  claimAndUpsertConnection(input: Parameters<WhoopRepository["claimAndUpsertConnection"]>[0]): Promise<number | null>;
  markInitialBackfillQueued(whoopUserId: number, credentialVersion: number, queuedAt: string): Promise<boolean>;
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

const messagesFor = (
  kind: "backfill" | "reconcile",
  whoopUserId: number,
  connectionId: string,
): WhoopQueueMessage[] => INITIAL_RESOURCES.map((resource) => ({
  kind,
  whoopUserId,
  connectionId,
  resource,
}));

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
        messagesFor("backfill", profile.user_id, connectionId).map((body) => ({ body })),
      );
      const markedQueued = await repository.markInitialBackfillQueued(
        profile.user_id,
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

  app.post("/v1/integrations/whoop/sync", async (c) => {
    if (!configured(c.env)) return c.json({ error: "WHOOP integration is not configured" }, 503);
    const connection = await repositoryFor(c.env).getCurrentConnection();
    if (!connectionCanSync(connection)) return c.json({ error: "WHOOP is not connected" }, 409);
    await Promise.all(messagesFor(
      "reconcile",
      connection.whoopUserId,
      connection.connectionId,
    ).map((message) => c.env.WHOOP_SYNC_QUEUE.send(message)));
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
