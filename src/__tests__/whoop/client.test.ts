import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WhoopClient,
  WhoopRequestError,
  WhoopUnauthorizedError,
} from "../../services/whoop/client";
import {
  BODY_MEASUREMENT,
  CYCLE,
  CURRENT_CYCLE,
  ENV,
  PROFILE,
  RECOVERY,
  SLEEP,
  WORKOUT,
  jsonResponse,
} from "./fixtures";

const TOKEN_RESPONSE = {
  access_token: "rotated-access",
  refresh_token: "rotated-refresh",
  expires_in: 3600,
  token_type: "bearer",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WHOOP v2 client", () => {
  it("uses the v2 activity path, bearer token, next token, and original record JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ records: [SLEEP], next_token: "page-2" }),
    );
    const client = new WhoopClient(ENV, "access");

    const page = await client.getCollection("sleep", { limit: 25 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.prod.whoop.com/developer/v2/activity/sleep?limit=25",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer access" }) }),
    );
    expect(page.nextToken).toBe("page-2");
    expect(page.records).toEqual([{ ...SLEEP, rawJson: JSON.stringify(SLEEP) }]);
  });

  it("uses the v2 collection and detail paths for every activity resource", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ records: [CYCLE] }))
      .mockResolvedValueOnce(jsonResponse({ records: [RECOVERY] }))
      .mockResolvedValueOnce(jsonResponse({ records: [WORKOUT] }))
      .mockResolvedValueOnce(jsonResponse(CURRENT_CYCLE))
      .mockResolvedValueOnce(jsonResponse(RECOVERY))
      .mockResolvedValueOnce(jsonResponse(SLEEP))
      .mockResolvedValueOnce(jsonResponse(WORKOUT));
    const client = new WhoopClient(ENV, "access");

    await client.getCollection("cycle", { start: "2026-08-19T00:00:00.000Z", end: "2026-08-20T00:00:00.000Z", nextToken: "next" });
    await client.getCollection("recovery", { limit: 25 });
    await client.getCollection("workout", { limit: 25 });
    await client.getCycle(9);
    await client.getRecovery(9);
    await client.getSleep(SLEEP.id);
    await client.getWorkout(WORKOUT.id);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.prod.whoop.com/developer/v2/cycle?start=2026-08-19T00%3A00%3A00.000Z&end=2026-08-20T00%3A00%3A00.000Z&nextToken=next",
      "https://api.prod.whoop.com/developer/v2/recovery?limit=25",
      "https://api.prod.whoop.com/developer/v2/activity/workout?limit=25",
      "https://api.prod.whoop.com/developer/v2/cycle/9",
      "https://api.prod.whoop.com/developer/v2/recovery/9",
      `https://api.prod.whoop.com/developer/v2/activity/sleep/${SLEEP.id}`,
      `https://api.prod.whoop.com/developer/v2/activity/workout/${WORKOUT.id}`,
    ]);
  });

  it("validates user responses and keeps body user context outside the provider payload", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(PROFILE))
      .mockResolvedValueOnce(jsonResponse(BODY_MEASUREMENT));
    const client = new WhoopClient(ENV, "access");

    await expect(client.getProfile()).resolves.toEqual({ ...PROFILE, rawJson: JSON.stringify(PROFILE) });
    await expect(client.getBodyMeasurements()).resolves.toEqual({
      ...BODY_MEASUREMENT,
      rawJson: JSON.stringify(BODY_MEASUREMENT),
    });
  });

  it("exchanges and refreshes tokens through the OAuth endpoint without logging token values", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE));
    const client = new WhoopClient(ENV, "access");

    await expect(client.exchangeAuthorizationCode("test-code")).resolves.toEqual(TOKEN_RESPONSE);
    await expect(client.refreshToken("test-refresh")).resolves.toEqual(TOKEN_RESPONSE);

    expect(fetchMock).toHaveBeenNthCalledWith(1,
      "https://api.prod.whoop.com/oauth/oauth2/token",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=test-code&redirect_uri=https%3A%2F%2Fapi.example.test%2Fintegrations%2Fwhoop%2Fcallback&client_id=test-whoop-client-id&client_secret=test-whoop-client-secret",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      "https://api.prod.whoop.com/oauth/oauth2/token",
      expect.objectContaining({ body: "grant_type=refresh_token&refresh_token=test-refresh&client_id=test-whoop-client-id&client_secret=test-whoop-client-secret" }),
    );
  });

  it("revokes access at the documented v2 endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const client = new WhoopClient(ENV, "access");

    await expect(client.revokeAccess("access-to-revoke")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.prod.whoop.com/developer/v2/user/access",
      expect.objectContaining({ method: "DELETE", headers: { authorization: "Bearer access-to-revoke" } }),
    );
  });

  it("turns a retry-after response into a retryable sanitized error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("provider detail must not be exposed", { status: 429, headers: { "retry-after": "30" } }),
    );
    const client = new WhoopClient(ENV, "access");

    await expect(client.getCollection("workout", { limit: 25 })).rejects.toMatchObject({
      name: "WhoopRequestError",
      status: 429,
      retryAfterSeconds: 30,
      retryable: true,
    });
    await expect(client.getCollection("workout", { limit: 25 })).rejects.not.toThrow("provider detail must not be exposed");
  });

  it("uses the rate-limit reset as a retry delay and makes 5xx retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("provider detail must not be exposed", {
        status: 503,
        headers: { "x-ratelimit-reset": "1800000060" },
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const client = new WhoopClient(ENV, "access");

    await expect(client.getProfile()).rejects.toMatchObject({
      name: "WhoopRequestError",
      status: 503,
      retryAfterSeconds: 60,
      retryable: true,
    });
  });

  it("identifies unauthorized responses and never includes upstream bodies in errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("authorization bearer access must not appear", { status: 401 }),
    );
    const client = new WhoopClient(ENV, "access");

    await expect(client.getProfile()).rejects.toBeInstanceOf(WhoopUnauthorizedError);
    await expect(client.getProfile()).rejects.not.toThrow("authorization bearer access must not appear");
  });

  it("rejects malformed successful provider payloads without treating them as HTTP retry errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ user_id: 42 }));
    const client = new WhoopClient(ENV, "access");

    await expect(client.getProfile()).rejects.not.toBeInstanceOf(WhoopRequestError);
  });
});
