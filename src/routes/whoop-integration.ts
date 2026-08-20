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
  okSchema,
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
  upsertConnection(input: Parameters<WhoopRepository["upsertConnection"]>[0]): Promise<void>;
  withWhoopAccessToken<T>(
    whoopUserId: number,
    request: (accessToken: string) => Promise<T>,
    refresh: (refreshToken: string, options: { signal: AbortSignal }) => Promise<WhoopTokenResponse>,
  ): Promise<T>;
  disconnect(whoopUserId: number, disconnectedAt: string): Promise<boolean>;
  deleteLocalData(whoopUserId: number): Promise<void>;
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
  if (!env.WHOOP_SYNC_QUEUE || typeof env.WHOOP_SYNC_QUEUE.send !== "function") return false;
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

const messagesFor = (kind: "backfill" | "reconcile", whoopUserId: number): WhoopQueueMessage[] =>
  INITIAL_RESOURCES.map((resource) => ({ kind, whoopUserId, resource }));

export function createWhoopIntegrationRoute(dependencies: WhoopIntegrationDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const now = dependencies.now ?? (() => new Date());
  const repositoryFor = (env: Env): IntegrationRepository => dependencies.repository
    ?? new WhoopRepository(env.DB, env.WHOOP_TOKEN_ENCRYPTION_KEY);
  const clientFor = (env: Env, accessToken: string): IntegrationClient => dependencies.clientFactory?.(env, accessToken)
    ?? new WhoopClient(env, accessToken);
  const callbackFailure = (env: Env) => new Response(null, {
    status: 302,
    headers: { location: resultRedirect(env, "failed") },
  });

  app.get("/v1/integrations/whoop", async (c) => {
    const repository = repositoryFor(c.env);
    const connection = await repository.getCurrentConnection();
    if (!connection) return c.json({ status: "not_connected", progress: [] });
    const progress = await repository.getSyncProgress(connection.whoopUserId);
    const { whoopUserId: _whoopUserId, ...status } = connection;
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
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return callbackFailure(c.env);
    try {
      const repository = repositoryFor(c.env);
      const consumed = await repository.consumeOAuthState(await hashOAuthState(state), now().toISOString());
      if (!consumed) return callbackFailure(c.env);
      const unauthenticatedClient = clientFor(c.env, "");
      const tokens = await unauthenticatedClient.exchangeAuthorizationCode(code);
      const authenticatedClient = clientFor(c.env, tokens.access_token);
      const profile = await authenticatedClient.getProfile();
      const existing = await repository.getCurrentConnection();
      if (existing && existing.whoopUserId !== profile.user_id && existing.status !== "disconnected") {
        return callbackFailure(c.env);
      }
      const connectedAt = now();
      const [accessToken, refreshToken] = await Promise.all([
        encryptWhoopToken(c.env.WHOOP_TOKEN_ENCRYPTION_KEY, profile.user_id, "access", tokens.access_token),
        encryptWhoopToken(c.env.WHOOP_TOKEN_ENCRYPTION_KEY, profile.user_id, "refresh", tokens.refresh_token),
      ]);
      await repository.upsertConnection({
        whoopUserId: profile.user_id,
        status: "backfilling",
        accessToken,
        accessTokenExpiresAt: new Date(connectedAt.getTime() + tokens.expires_in * 1000).toISOString(),
        refreshToken,
        grantedScopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? WHOOP_SCOPES,
        connectedAt: connectedAt.toISOString(),
      });
      await Promise.all(messagesFor("backfill", profile.user_id).map((message) => c.env.WHOOP_SYNC_QUEUE.send(message)));
      return c.redirect(resultRedirect(c.env, "connected"));
    } catch {
      return callbackFailure(c.env);
    }
  });

  app.post("/v1/integrations/whoop/sync", async (c) => {
    if (!configured(c.env)) return c.json({ error: "WHOOP integration is not configured" }, 503);
    const connection = await repositoryFor(c.env).getCurrentConnection();
    if (!connectionCanSync(connection)) return c.json({ error: "WHOOP is not connected" }, 409);
    await Promise.all(messagesFor("reconcile", connection.whoopUserId).map((message) => c.env.WHOOP_SYNC_QUEUE.send(message)));
    return c.json({ ok: true }, 202);
  });

  app.delete("/v1/integrations/whoop", async (c) => {
    if (!configured(c.env)) return c.json({ error: "WHOOP integration is not configured" }, 503);
    const repository = repositoryFor(c.env);
    const connection = await repository.getCurrentConnection();
    if (!connectionCanSync(connection)) return c.json({ error: "WHOOP is not connected" }, 409);
    try {
      await repository.withWhoopAccessToken(
        connection.whoopUserId,
        (accessToken) => clientFor(c.env, accessToken).revokeAccess(accessToken),
        (refreshToken, options) => clientFor(c.env, "").refreshToken(refreshToken, options),
      );
      const disconnected = await repository.disconnect(connection.whoopUserId, now().toISOString());
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
    await repository.deleteLocalData(connection.whoopUserId);
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

for (const [method, path, summary] of [
  ["post", "/v1/integrations/whoop/sync", "Queue WHOOP reconciliation"],
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
