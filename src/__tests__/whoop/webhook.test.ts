import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import { getOpenApiDocument } from "../../schemas/openapi";
import {
  createWhoopIntegrationRoute,
  type WhoopIntegrationDependencies,
} from "../../routes/whoop-integration";
import type { Env } from "../../types/env";
import type { WhoopWebhookEvent } from "../../types/whoop";
import {
  CONNECTION_ID,
  ENV,
  NOW,
  NOW_MINUS_SIX_MINUTES_MS,
  NOW_MS,
  SLEEP_UPDATED,
  signedWebhook,
} from "./fixtures";

const encoder = new TextEncoder();

function createDependencies() {
  const repository = {
    getCurrentConnection: vi.fn().mockResolvedValue({
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      credentialVersion: 3,
      reconcileGeneration: 7,
      status: "active",
    }),
    recordWebhookEvent: vi.fn().mockResolvedValue(true),
    getWebhookEventStatus: vi.fn().mockResolvedValue("queued"),
    markWebhookQueued: vi.fn().mockResolvedValue(true),
  };
  const dependencies = {
    repository,
    now: () => new Date(NOW),
  } as unknown as WhoopIntegrationDependencies;
  return { dependencies, repository };
}

function createApp(dependencies: WhoopIntegrationDependencies) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", createWhoopIntegrationRoute(dependencies));
  return app;
}

async function signedRaw(body: string, timestamp = NOW_MS): Promise<RequestInit> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ENV.WHOOP_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp + body));
  return {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "X-WHOOP-Signature": btoa(String.fromCharCode(...new Uint8Array(signature))),
      "X-WHOOP-Signature-Timestamp": timestamp,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (ENV.WHOOP_SYNC_QUEUE.send as unknown as ReturnType<typeof vi.fn>).mockReset();
});

describe("WHOOP public webhook", () => {
  it("publishes the exact signature headers and response contract in OpenAPI", () => {
    const document = getOpenApiDocument("test", "https://api.example.test") as {
      paths: Record<string, { post?: Record<string, unknown> }>;
    };
    const operation = document.paths["/integrations/whoop/webhook"].post as {
      parameters: Array<{ in: string; name: string; required?: boolean }>;
      responses: Record<string, unknown>;
      security?: unknown;
    };

    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "header", name: "X-WHOOP-Signature", required: true }),
      expect.objectContaining({ in: "header", name: "X-WHOOP-Signature-Timestamp", required: true }),
    ]));
    expect(Object.keys(operation.responses).sort()).toEqual(["204", "400", "401", "503"]);
    expect(operation.security).toBeUndefined();
  });

  it("mounts outside bearer-protected v1 routes", async () => {
    const response = await worker.fetch(new Request(
      "https://api.example.test/integrations/whoop/webhook",
      { method: "POST" },
    ), ENV);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid WHOOP webhook signature" });
  });

  it("authenticates the exact raw body once and queues the lifecycle-fenced event", async () => {
    const { dependencies, repository } = createDependencies();
    const app = createApp(dependencies);
    const rawBody = ` { "user_id": 42, "id": "${SLEEP_UPDATED.id}", "type": "sleep.updated", "trace_id": "${SLEEP_UPDATED.trace_id}" } `;
    const request = new Request("https://api.example.test/integrations/whoop/webhook", await signedRaw(rawBody));
    const text = vi.spyOn(request, "text");

    const response = await app.fetch(request, ENV);

    expect(response.status).toBe(204);
    expect(text).toHaveBeenCalledTimes(1);
    expect(repository.recordWebhookEvent).toHaveBeenCalledWith({
      traceId: SLEEP_UPDATED.trace_id,
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      resourceId: SLEEP_UPDATED.id,
      eventType: "sleep.updated",
      receivedAt: NOW,
    });
    expect(ENV.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledWith({
      kind: "webhook",
      traceId: SLEEP_UPDATED.trace_id,
      whoopUserId: 42,
      connectionId: CONNECTION_ID,
      resourceId: SLEEP_UPDATED.id,
      eventType: "sleep.updated",
    });
    expect(repository.markWebhookQueued).toHaveBeenCalledWith(
      SLEEP_UPDATED.trace_id,
      42,
      CONNECTION_ID,
    );
  });

  it("acknowledges an already queued duplicate without publishing it again", async () => {
    const { dependencies, repository } = createDependencies();
    repository.recordWebhookEvent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    repository.getWebhookEventStatus.mockResolvedValue("queued");
    const app = createApp(dependencies);

    const first = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(SLEEP_UPDATED),
      ENV,
    );
    const duplicate = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(SLEEP_UPDATED),
      ENV,
    );

    expect(first.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(ENV.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledTimes(1);
  });

  it("retries publication for a duplicate still durably received after queue failure", async () => {
    const { dependencies, repository } = createDependencies();
    repository.recordWebhookEvent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    repository.getWebhookEventStatus.mockResolvedValue("received");
    (ENV.WHOOP_SYNC_QUEUE.send as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("fixture queue secret detail"))
      .mockResolvedValueOnce(undefined);
    const app = createApp(dependencies);

    const failed = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(SLEEP_UPDATED),
      ENV,
    );
    const retried = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(SLEEP_UPDATED),
      ENV,
    );

    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error: "WHOOP webhook queue unavailable" });
    expect(retried.status).toBe(204);
    expect(ENV.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledTimes(2);
    expect(repository.markWebhookQueued).toHaveBeenCalledTimes(1);
  });

  it("never republishes a trace owned by an old connection lifecycle", async () => {
    const { dependencies, repository } = createDependencies();
    repository.recordWebhookEvent.mockResolvedValue(false);
    repository.getWebhookEventStatus.mockResolvedValue(null);
    const app = createApp(dependencies);

    const response = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(SLEEP_UPDATED),
      ENV,
    );

    expect(response.status).toBe(204);
    expect(repository.getWebhookEventStatus).toHaveBeenCalledWith(
      SLEEP_UPDATED.trace_id,
      42,
      CONNECTION_ID,
    );
    expect(ENV.WHOOP_SYNC_QUEUE.send).not.toHaveBeenCalled();
  });

  it("acknowledges a lifecycle change after publication so the fenced queue message becomes stale", async () => {
    const { dependencies, repository } = createDependencies();
    repository.markWebhookQueued.mockResolvedValue(false);
    repository.getWebhookEventStatus.mockResolvedValue(null);
    const app = createApp(dependencies);

    const response = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(SLEEP_UPDATED),
      ENV,
    );

    expect(response.status).toBe(204);
    expect(ENV.WHOOP_SYNC_QUEUE.send).toHaveBeenCalledTimes(1);
    expect(repository.markWebhookQueued).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a signed event that does not match an active connection without persistence", async () => {
    const { dependencies, repository } = createDependencies();
    repository.getCurrentConnection.mockResolvedValue({
      whoopUserId: 7,
      connectionId: "other-connection",
      credentialVersion: 1,
      reconcileGeneration: 0,
      status: "active",
    });
    const app = createApp(dependencies);

    const response = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(SLEEP_UPDATED),
      ENV,
    );

    expect(response.status).toBe(204);
    expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
    expect(ENV.WHOOP_SYNC_QUEUE.send).not.toHaveBeenCalled();
  });

  it.each([
    ["past", NOW_MINUS_SIX_MINUTES_MS],
    ["future", String(Number(NOW_MS) + 6 * 60 * 1000)],
  ])("rejects a timestamp more than five minutes in the %s", async (_label, timestamp) => {
    const { dependencies, repository } = createDependencies();
    const app = createApp(dependencies);

    const response = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(SLEEP_UPDATED, timestamp),
      ENV,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid WHOOP webhook signature" });
    expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
  });

  it("accepts a timestamp exactly five minutes from the current clock", async () => {
    const { dependencies } = createDependencies();
    const app = createApp(dependencies);
    const timestamp = String(Number(NOW_MS) - 5 * 60 * 1000);

    const response = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(SLEEP_UPDATED, timestamp),
      ENV,
    );

    expect(response.status).toBe(204);
  });

  it.each(["", "not-a-number", "1787140800000.5", "1e3", "1787140800 000"])(
    "rejects the malformed timestamp header %j",
    async (timestamp) => {
      const { dependencies, repository } = createDependencies();
      const app = createApp(dependencies);
      const init = await signedWebhook(SLEEP_UPDATED);
      const headers = new Headers(init.headers);
      headers.set("X-WHOOP-Signature-Timestamp", timestamp);

      const response = await app.request(
        "/integrations/whoop/webhook",
        { ...init, headers },
        ENV,
      );

      expect(response.status).toBe(401);
      expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
    },
  );

  it("rejects missing or malformed base64 signatures before persistence", async () => {
    const { dependencies, repository } = createDependencies();
    const app = createApp(dependencies);
    const missing = await app.request("/integrations/whoop/webhook", { method: "POST" }, ENV);
    const init = await signedWebhook(SLEEP_UPDATED);
    const headers = new Headers(init.headers);
    headers.set("X-WHOOP-Signature", "%%%not-base64%%%");
    const malformed = await app.request(
      "/integrations/whoop/webhook",
      { ...init, headers },
      ENV,
    );

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects a canonical-length but incorrect base64 signature", async () => {
    const { dependencies, repository } = createDependencies();
    const app = createApp(dependencies);
    const init = await signedWebhook(SLEEP_UPDATED);
    const headers = new Headers(init.headers);
    headers.set("X-WHOOP-Signature", `${"A".repeat(43)}=`);

    const response = await app.request(
      "/integrations/whoop/webhook",
      { ...init, headers },
      ENV,
    );

    expect(response.status).toBe(401);
    expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects a validly signed non-strict envelope before persistence", async () => {
    const { dependencies, repository } = createDependencies();
    const app = createApp(dependencies);
    const payload = { ...SLEEP_UPDATED, unexpected: true } as unknown as WhoopWebhookEvent;

    const response = await app.request(
      "/integrations/whoop/webhook",
      await signedWebhook(payload),
      ENV,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid WHOOP webhook payload" });
    expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
    expect(ENV.WHOOP_SYNC_QUEUE.send).not.toHaveBeenCalled();
  });
});
