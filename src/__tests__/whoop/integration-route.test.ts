import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import { requireAuth } from "../../middleware/auth";
import {
  createWhoopIntegrationRoute,
  type WhoopIntegrationDependencies,
} from "../../routes/whoop-integration";
import type { Env } from "../../types/env";
import { getOpenApiDocument } from "../../schemas/openapi";
import { ENV, PROFILE, bearerGet, bearerPost } from "./fixtures";

const FIXED_CONNECTED_REDIRECT = "https://os.example.test/health/source?result=connected";
const FIXED_FAILED_REDIRECT = "https://os.example.test/health/source?result=failed";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000042";
const RESOURCES = ["profile", "body_measurement", "cycle", "recovery", "sleep", "workout"] as const;

type Connection = {
  whoopUserId: number;
  connectionId?: string;
  status: "not_connected" | "backfilling" | "active" | "disconnected";
  credentialVersion: number;
  granted_scopes?: string[];
};

function createDependencies(connection: Connection | null = null) {
  const currentConnection = connection ? {
    ...connection,
    connectionId: connection.connectionId ?? CONNECTION_ID,
  } : null;
  const repository = {
    createOAuthState: vi.fn().mockResolvedValue(undefined),
    consumeOAuthState: vi.fn().mockResolvedValue(true),
    getCurrentConnection: vi.fn().mockResolvedValue(currentConnection),
    getSyncProgress: vi.fn().mockResolvedValue([]),
    claimAndUpsertConnection: vi.fn().mockResolvedValue(1),
    markInitialBackfillQueued: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(true),
    deleteLocalData: vi.fn().mockResolvedValue(true),
    withWhoopAccessToken: vi.fn(async (_userId, request) => request("fixture-access-token", connection?.credentialVersion ?? 1)),
  };
  const client = {
    exchangeAuthorizationCode: vi.fn().mockResolvedValue({
      access_token: "fixture-access-token",
      refresh_token: "fixture-refresh-token",
      expires_in: 3600,
      token_type: "bearer",
      scope: "offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout",
    }),
    getProfile: vi.fn().mockResolvedValue(PROFILE),
    revokeAccess: vi.fn().mockResolvedValue(undefined),
  };
  const clientFactory = vi.fn().mockReturnValue(client);
  const dependencies = {
    repository,
    clientFactory,
    now: () => new Date("2026-08-19T12:00:00.000Z"),
  } as unknown as WhoopIntegrationDependencies;
  return { dependencies, repository, client, clientFactory };
}

function createApp(dependencies: WhoopIntegrationDependencies) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/v1/*", requireAuth);
  app.route("/", createWhoopIntegrationRoute(dependencies));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WHOOP integration management routes", () => {
  it("mounts the management route behind the worker bearer middleware", async () => {
    const response = await worker.fetch(new Request("https://api.example.test/v1/integrations/whoop/connect", {
      method: "POST",
    }), ENV);

    expect(response.status).toBe(401);
  });

  it("requires bearer auth and returns only a fixed-redirect authorization URL", async () => {
    const { dependencies, repository } = createDependencies();
    const app = createApp(dependencies);

    const unauthorized = await app.request("/v1/integrations/whoop/connect", { method: "POST" }, ENV);
    const authorized = await app.request("/v1/integrations/whoop/connect", bearerPost(), ENV);
    const body = await authorized.json() as Record<string, unknown>;

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(Object.keys(body)).toEqual(["authorization_url"]);
    expect(body.authorization_url).toContain(encodeURIComponent(ENV.WHOOP_REDIRECT_URI));
    expect(new URL(String(body.authorization_url)).searchParams.get("scope"))
      .toBe("offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout");
    expect(body.authorization_url).not.toContain("returnTo");
    expect(repository.createOAuthState).toHaveBeenCalledTimes(1);
  });

  it("validates all required bindings before persisting OAuth state", async () => {
    const { dependencies, repository } = createDependencies();
    const app = createApp(dependencies);
    const env = { ...ENV, OS_BASE_URL: "" } as Env;

    const response = await app.request("/v1/integrations/whoop/connect", bearerPost(), env);

    expect(response.status).toBe(503);
    expect(repository.createOAuthState).not.toHaveBeenCalled();
  });

  it("consumes callback state before code exchange and redirects failures without query values", async () => {
    const { dependencies, repository, client } = createDependencies();
    repository.consumeOAuthState.mockResolvedValue(false);
    const app = createApp(dependencies);

    const response = await app.request("/integrations/whoop/callback?code=redacted-code&state=used-state", {}, ENV);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(FIXED_FAILED_REDIRECT);
    expect(client.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(response.headers.get("location")).not.toContain("redacted-code");
    expect(response.headers.get("location")).not.toContain("used-state");
  });

  it("encrypts callback tokens, starts a six-resource backfill, and redirects only to the OS result", async () => {
    const { dependencies, repository } = createDependencies();
    const app = createApp(dependencies);

    const response = await app.request("/integrations/whoop/callback?code=redacted-code&state=fresh-state", {}, ENV);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(FIXED_CONNECTED_REDIRECT);
    expect(repository.claimAndUpsertConnection).toHaveBeenCalledWith(expect.objectContaining({
      whoopUserId: PROFILE.user_id,
      connectionId: expect.any(String),
      status: "backfilling",
      initialBackfillPending: true,
      accessToken: expect.objectContaining({ ciphertext: expect.any(String), nonce: expect.any(String) }),
      refreshToken: expect.objectContaining({ ciphertext: expect.any(String), nonce: expect.any(String) }),
    }));
    expect(ENV.WHOOP_SYNC_QUEUE.send).not.toHaveBeenCalled();
    expect(ENV.WHOOP_SYNC_QUEUE.sendBatch).toHaveBeenCalledWith(RESOURCES.map((resource) => ({
      body: {
        kind: "backfill",
        whoopUserId: PROFILE.user_id,
        connectionId: expect.any(String),
        resource,
      },
    })));
    expect(repository.markInitialBackfillQueued).toHaveBeenCalledWith(PROFILE.user_id, 1, expect.any(String));
  });

  it("does not replace an existing active WHOOP identity", async () => {
    const { dependencies, repository, client } = createDependencies({ whoopUserId: 7, status: "active", credentialVersion: 1 });
    repository.claimAndUpsertConnection.mockResolvedValue(null);
    const app = createApp(dependencies);

    const response = await app.request("/integrations/whoop/callback?code=redacted-code&state=fresh-state", {}, ENV);

    expect(response.headers.get("location")).toBe(FIXED_FAILED_REDIRECT);
    expect(repository.claimAndUpsertConnection).toHaveBeenCalledTimes(1);
    expect(client.revokeAccess).toHaveBeenCalledWith("fixture-access-token");
    expect(ENV.WHOOP_SYNC_QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  it("best-effort revokes an exchanged token when pre-claim persistence fails", async () => {
    const { dependencies, repository, client } = createDependencies();
    const app = createApp(dependencies);
    const env = { ...ENV, WHOOP_TOKEN_ENCRYPTION_KEY: "invalid" } as Env;

    const response = await app.request("/integrations/whoop/callback?code=redacted-code&state=fresh-state", {}, env);

    expect(response.headers.get("location")).toBe(FIXED_FAILED_REDIRECT);
    expect(repository.claimAndUpsertConnection).not.toHaveBeenCalled();
    expect(client.revokeAccess).toHaveBeenCalledWith("fixture-access-token");
  });

  it("keeps durable initial-backfill intent when the atomic queue batch is ambiguous", async () => {
    const { dependencies, repository, client } = createDependencies();
    const app = createApp(dependencies);
    (ENV.WHOOP_SYNC_QUEUE.sendBatch as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("queue publication unknown"));

    const response = await app.request("/integrations/whoop/callback?code=redacted-code&state=fresh-state", {}, ENV);

    expect(response.headers.get("location")).toBe(FIXED_FAILED_REDIRECT);
    expect(repository.claimAndUpsertConnection).toHaveBeenCalledWith(expect.objectContaining({ initialBackfillPending: true }));
    expect(repository.markInitialBackfillQueued).not.toHaveBeenCalled();
    expect(ENV.WHOOP_SYNC_QUEUE.send).not.toHaveBeenCalled();
    expect(ENV.WHOOP_SYNC_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    expect(client.revokeAccess).not.toHaveBeenCalled();
  });

  it("consumes a valid state before failing a provider denial without code exchange", async () => {
    const { dependencies, repository, client } = createDependencies();
    const app = createApp(dependencies);

    const response = await app.request("/integrations/whoop/callback?state=fresh-state&error=access_denied", {}, ENV);

    expect(response.headers.get("location")).toBe(FIXED_FAILED_REDIRECT);
    expect(repository.consumeOAuthState).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    expect(client.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("queues only reconciliation work for a manual sync", async () => {
    const { dependencies, client } = createDependencies({ whoopUserId: PROFILE.user_id, status: "active", credentialVersion: 1 });
    const app = createApp(dependencies);

    const response = await app.request("/v1/integrations/whoop/sync", bearerPost(), ENV);

    expect(response.status).toBe(202);
    expect(ENV.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledTimes(6);
    expect((ENV.WHOOP_SYNC_QUEUE.send as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message))
      .toEqual(RESOURCES.map((resource) => ({
        kind: "reconcile",
        whoopUserId: PROFILE.user_id,
        connectionId: CONNECTION_ID,
        resource,
      })));
    expect(client.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("revokes before clearing token fields and keeps imported source history", async () => {
    const { dependencies, repository, client } = createDependencies({ whoopUserId: PROFILE.user_id, status: "active", credentialVersion: 1 });
    const app = createApp(dependencies);

    const response = await app.request("/v1/integrations/whoop", { method: "DELETE", ...bearerGet() }, ENV);

    expect(response.status).toBe(200);
    expect(client.revokeAccess).toHaveBeenCalledWith("fixture-access-token");
    expect(repository.disconnect).toHaveBeenCalledWith(PROFILE.user_id, 1, expect.any(String));
    expect(repository.deleteLocalData).not.toHaveBeenCalled();
  });

  it("disconnects using the refreshed generation that successfully revoked WHOOP access", async () => {
    const { dependencies, repository, client } = createDependencies({ whoopUserId: PROFILE.user_id, status: "active", credentialVersion: 1 });
    repository.withWhoopAccessToken.mockImplementation(async (_userId, request) => request("rotated-access-token", 2));
    const app = createApp(dependencies);

    const response = await app.request("/v1/integrations/whoop", { method: "DELETE", ...bearerGet() }, ENV);

    expect(response.status).toBe(200);
    expect(client.revokeAccess).toHaveBeenCalledWith("rotated-access-token");
    expect(repository.disconnect).toHaveBeenCalledWith(PROFILE.user_id, 2, expect.any(String));
  });

  it("does not clear credentials when WHOOP revocation fails", async () => {
    const { dependencies, repository, client } = createDependencies({ whoopUserId: PROFILE.user_id, status: "active", credentialVersion: 1 });
    client.revokeAccess.mockRejectedValue(new Error("upstream detail"));
    const app = createApp(dependencies);

    const response = await app.request("/v1/integrations/whoop", { method: "DELETE", ...bearerGet() }, ENV);

    expect(response.status).toBe(502);
    expect(repository.disconnect).not.toHaveBeenCalled();
  });

  it("allows local WHOOP data deletion only after disconnect", async () => {
    const active = createDependencies({ whoopUserId: PROFILE.user_id, status: "active", credentialVersion: 1 });
    const disconnected = createDependencies({ whoopUserId: PROFILE.user_id, status: "disconnected", credentialVersion: 2 });

    const activeResponse = await createApp(active.dependencies)
      .request("/v1/integrations/whoop/data", { method: "DELETE", ...bearerGet() }, ENV);
    const disconnectedResponse = await createApp(disconnected.dependencies)
      .request("/v1/integrations/whoop/data", { method: "DELETE", ...bearerGet() }, ENV);

    expect(activeResponse.status).toBe(409);
    expect(active.repository.deleteLocalData).not.toHaveBeenCalled();
    expect(disconnectedResponse.status).toBe(200);
    expect(disconnected.repository.deleteLocalData).toHaveBeenCalledWith(PROFILE.user_id, 2);
  });

  it("returns conflict when a concurrent reconnect invalidates disconnect or local-delete CAS", async () => {
    const disconnect = createDependencies({ whoopUserId: PROFILE.user_id, status: "active", credentialVersion: 1 });
    disconnect.repository.disconnect.mockResolvedValue(false);
    const deletion = createDependencies({ whoopUserId: PROFILE.user_id, status: "disconnected", credentialVersion: 2 });
    deletion.repository.deleteLocalData.mockResolvedValue(false);

    const disconnectResponse = await createApp(disconnect.dependencies)
      .request("/v1/integrations/whoop", { method: "DELETE", ...bearerGet() }, ENV);
    const deleteResponse = await createApp(deletion.dependencies)
      .request("/v1/integrations/whoop/data", { method: "DELETE", ...bearerGet() }, ENV);

    expect(disconnectResponse.status).toBe(409);
    expect(deleteResponse.status).toBe(409);
  });

  it("returns a token-free connection and progress projection", async () => {
    const { dependencies, repository } = createDependencies({
      whoopUserId: PROFILE.user_id,
      status: "active",
      credentialVersion: 1,
      granted_scopes: ["offline", "read:profile"],
    });
    repository.getSyncProgress.mockResolvedValue([{ resource: "sleep", mode: "backfill", status: "running" }]);
    const app = createApp(dependencies);

    const response = await app.request("/v1/integrations/whoop", bearerGet(), ENV);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "active",
      granted_scopes: ["offline", "read:profile"],
      progress: [{ resource: "sleep", mode: "backfill", status: "running" }],
    });
    expect(JSON.stringify(body)).not.toMatch(/token|ciphertext|nonce|raw_json/i);
  });

  it("advertises asynchronous reconciliation and exact WHOOP status/progress values", () => {
    const document = getOpenApiDocument("test");
    const sync = document.paths?.["/v1/integrations/whoop/sync"]?.post;
    const status = document.paths?.["/v1/integrations/whoop"]?.get;

    expect(sync?.responses).toHaveProperty("202");
    expect(JSON.stringify(status)).toContain("not_connected");
    expect(JSON.stringify(status)).toContain("backfilling");
    expect(JSON.stringify(status)).toContain("body_measurement");
    expect(JSON.stringify(status)).toContain("page_count");
  });
});
