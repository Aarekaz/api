import { z } from "zod";
import {
  whoopBodyMeasurementSchema,
  whoopCollectionResponseSchema,
  whoopCycleSchema,
  whoopProfileSchema,
  whoopRecoverySchema,
  whoopSleepSchema,
  whoopWorkoutSchema,
} from "../../schemas/whoop";
import type {
  WhoopBodyMeasurement,
  WhoopCycle,
  WhoopProfile,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
} from "../../schemas/whoop";
import type { Env } from "../../types/env";

const WHOOP_BASE_URL = "https://api.prod.whoop.com";
const WHOOP_DEVELOPER_V2_PATH = "/developer/v2";
const WHOOP_TOKEN_PATH = "/oauth/oauth2/token";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().finite().nonnegative(),
  token_type: z.string().min(1),
  scope: z.string().optional(),
}).passthrough();

type WhoopCollectionResource = "cycle" | "recovery" | "sleep" | "workout";

interface WhoopCollectionRecordMap {
  cycle: WhoopCycle;
  recovery: WhoopRecovery;
  sleep: WhoopSleep;
  workout: WhoopWorkout;
}

const collectionDefinitions = {
  cycle: { path: "/cycle", schema: whoopCycleSchema },
  recovery: { path: "/recovery", schema: whoopRecoverySchema },
  sleep: { path: "/activity/sleep", schema: whoopSleepSchema },
  workout: { path: "/activity/workout", schema: whoopWorkoutSchema },
} as const;

export interface WhoopCollectionParams {
  start?: string;
  end?: string;
  limit?: number;
  nextToken?: string;
}

export type WhoopProviderRecord<T> = T & { rawJson: string };

export interface WhoopCollectionPage<T> {
  records: Array<WhoopProviderRecord<T>>;
  nextToken?: string;
}

export type WhoopTokenResponse = z.infer<typeof tokenResponseSchema>;

export interface WhoopRefreshOptions {
  signal?: AbortSignal;
}

export class WhoopRequestError extends Error {
  readonly name: string = "WhoopRequestError";

  constructor(
    readonly operation: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(status === undefined
      ? `WHOOP ${operation} request failed`
      : `WHOOP ${operation} request failed with status ${status}`);
  }
}

export class WhoopResponseSchemaError extends Error {
  readonly name = "WhoopResponseSchemaError";

  constructor(operation: string, issues: z.ZodIssue[]) {
    const summary = issues.slice(0, 3).map((issue) => {
      const path = issue.path.length === 0 ? "response" : issue.path.map(String).join(".");
      return `${path}:${issue.code}`;
    }).join(", ");
    super(`WHOOP ${operation} response schema mismatch at ${summary || "response:invalid"}`);
  }
}

export class WhoopUnauthorizedError extends WhoopRequestError {
  readonly name = "WhoopUnauthorizedError";

  constructor(operation: string) {
    super(operation, 401);
  }
}

export class WhoopRefreshAmbiguousError extends WhoopRequestError {
  readonly name = "WhoopRefreshAmbiguousError";
  readonly refreshOutcome = "ambiguous" as const;

  constructor(
    operation: string,
    status?: number,
    retryable = false,
    retryAfterSeconds?: number,
  ) {
    super(operation, status, retryable, retryAfterSeconds);
    this.message = "WHOOP token refresh outcome is unknown";
  }
}

export class WhoopRefreshDefiniteError extends WhoopRequestError {
  readonly name = "WhoopRefreshDefiniteError";
  readonly refreshOutcome = "definite" as const;
}

const retryAfterSeconds = (response: Response): number | undefined => {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds);
    }

    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) {
      return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    }
  }

  const rateLimitReset = response.headers.get("x-ratelimit-reset");
  if (!rateLimitReset) {
    return undefined;
  }

  const reset = Number(rateLimitReset);
  if (!Number.isFinite(reset)) {
    return undefined;
  }

  const resetAtMilliseconds = reset > 1_000_000_000_000 ? reset : reset * 1000;
  return Math.max(0, Math.ceil((resetAtMilliseconds - Date.now()) / 1000));
};

const asProviderRecord = <T>(payload: T, rawJson: string): WhoopProviderRecord<T> => ({
  ...payload,
  rawJson,
});

const parseProviderPayload = <T>(schema: z.ZodType<T>, payload: unknown, operation: string): WhoopProviderRecord<T> => {
  const rawJson = JSON.stringify(payload);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new WhoopResponseSchemaError(operation, parsed.error.issues);
  }
  return asProviderRecord(parsed.data, rawJson);
};

export class WhoopClient {
  constructor(
    private readonly env: Pick<Env, "WHOOP_CLIENT_ID" | "WHOOP_CLIENT_SECRET" | "WHOOP_REDIRECT_URI">,
    private readonly accessToken: string,
  ) {}

  async exchangeAuthorizationCode(code: string): Promise<WhoopTokenResponse> {
    return this.requestToken("token exchange", new URLSearchParams([
      ["grant_type", "authorization_code"],
      ["code", code],
      ["redirect_uri", this.env.WHOOP_REDIRECT_URI],
      ["client_id", this.env.WHOOP_CLIENT_ID],
      ["client_secret", this.env.WHOOP_CLIENT_SECRET],
    ]));
  }

  async refreshToken(refreshToken: string, options: WhoopRefreshOptions = {}): Promise<WhoopTokenResponse> {
    return this.requestToken("token refresh", new URLSearchParams([
      ["grant_type", "refresh_token"],
      ["refresh_token", refreshToken],
      ["scope", "offline"],
      ["client_id", this.env.WHOOP_CLIENT_ID],
      ["client_secret", this.env.WHOOP_CLIENT_SECRET],
    ]), options);
  }

  async revokeAccess(accessToken: string): Promise<void> {
    await this.request("revoke access", "/user/access", {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  async getProfile(): Promise<WhoopProviderRecord<WhoopProfile>> {
    return parseProviderPayload(whoopProfileSchema, await this.requestJson("profile", "/user/profile/basic"), "profile");
  }

  async getBodyMeasurements(): Promise<WhoopProviderRecord<WhoopBodyMeasurement>> {
    return parseProviderPayload(
      whoopBodyMeasurementSchema,
      await this.requestJson("body measurement", "/user/measurement/body"),
      "body measurement",
    );
  }

  async getCollection<R extends WhoopCollectionResource>(
    resource: R,
    params: WhoopCollectionParams = {},
  ): Promise<WhoopCollectionPage<WhoopCollectionRecordMap[R]>> {
    const definition = collectionDefinitions[resource];
    const normalizedParams = { ...params, limit: params.limit ?? 25 };
    if (!Number.isInteger(normalizedParams.limit) || normalizedParams.limit < 1 || normalizedParams.limit > 25) {
      throw new Error("WHOOP collection limit must be an integer from 1 to 25");
    }
    const payload = await this.requestJson(`list ${resource}`, `${definition.path}${this.query(normalizedParams)}`);
    const responseRecords = typeof payload === "object" && payload !== null
      ? (payload as { records?: unknown }).records
      : undefined;
    const rawRecords = Array.isArray(responseRecords)
      ? responseRecords.map((record) => JSON.stringify(record))
      : [];
    const parsed = whoopCollectionResponseSchema(definition.schema).safeParse(payload);
    if (!parsed.success) {
      throw new WhoopResponseSchemaError(`list ${resource}`, parsed.error.issues);
    }

    return {
      records: parsed.data.records.map((record, index) => asProviderRecord(
        record,
        rawRecords[index],
      )) as Array<WhoopProviderRecord<WhoopCollectionRecordMap[R]>>,
      nextToken: parsed.data.next_token ?? undefined,
    };
  }

  async getCycle(cycleId: number): Promise<WhoopProviderRecord<WhoopCycle>> {
    this.assertCycleId(cycleId);
    return parseProviderPayload(whoopCycleSchema, await this.requestJson("cycle", `/cycle/${cycleId}`), "cycle");
  }

  async getRecovery(cycleId: number): Promise<WhoopProviderRecord<WhoopRecovery>> {
    this.assertCycleId(cycleId);
    return parseProviderPayload(whoopRecoverySchema, await this.requestJson("recovery", `/cycle/${cycleId}/recovery`), "recovery");
  }

  async getSleep(sleepId: string): Promise<WhoopProviderRecord<WhoopSleep>> {
    this.assertActivityId(sleepId);
    return parseProviderPayload(whoopSleepSchema, await this.requestJson("sleep", `/activity/sleep/${sleepId}`), "sleep");
  }

  async getWorkout(workoutId: string): Promise<WhoopProviderRecord<WhoopWorkout>> {
    this.assertActivityId(workoutId);
    return parseProviderPayload(whoopWorkoutSchema, await this.requestJson("workout", `/activity/workout/${workoutId}`), "workout");
  }

  private async requestToken(
    operation: string,
    body: URLSearchParams,
    options: WhoopRefreshOptions = {},
  ): Promise<WhoopTokenResponse> {
    let payload: unknown;
    try {
      payload = await this.requestJson(operation, WHOOP_TOKEN_PATH, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: options.signal,
      }, false);
    } catch (error) {
      if (operation !== "token refresh") throw error;
      if (error instanceof WhoopRequestError
        && error.status !== undefined
        && error.status >= 400
        && error.status < 500) {
        throw new WhoopRefreshDefiniteError(
          operation,
          error.status,
          error.retryable,
          error.retryAfterSeconds,
        );
      }
      if (error instanceof WhoopRequestError) {
        throw new WhoopRefreshAmbiguousError(
          operation,
          error.status,
          error.retryable,
          error.retryAfterSeconds,
        );
      }
      throw new WhoopRefreshAmbiguousError(operation);
    }
    const parsed = tokenResponseSchema.safeParse(payload);
    if (!parsed.success) {
      if (operation === "token refresh") {
        throw new WhoopRefreshAmbiguousError(operation, 200);
      }
      throw new Error(`WHOOP ${operation} response did not match the provider schema`);
    }
    return parsed.data;
  }

  private async requestJson(operation: string, path: string, init?: RequestInit, includeBearer = true): Promise<unknown> {
    const response = await this.request(operation, path, init, includeBearer);
    try {
      return await response.json();
    } catch {
      throw new Error(`WHOOP ${operation} response was not valid JSON`);
    }
  }

  private async request(operation: string, path: string, init: RequestInit = {}, includeBearer = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (includeBearer && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }

    let response: Response;
    try {
      response = await fetch(`${WHOOP_BASE_URL}${path.startsWith("/oauth/") ? path : `${WHOOP_DEVELOPER_V2_PATH}${path}`}`, {
        ...init,
        headers: Object.fromEntries(headers),
      });
    } catch {
      throw new WhoopRequestError(operation);
    }

    if (response.ok) {
      return response;
    }
    if (response.status === 401) {
      throw new WhoopUnauthorizedError(operation);
    }

    const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
    throw new WhoopRequestError(operation, response.status, retryable, retryAfterSeconds(response));
  }

  private query(params: WhoopCollectionParams): string {
    const query = new URLSearchParams();
    if (params.start) query.set("start", params.start);
    if (params.end) query.set("end", params.end);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.nextToken) query.set("nextToken", params.nextToken);
    const serialized = query.toString();
    return serialized ? `?${serialized}` : "";
  }

  private assertCycleId(cycleId: number): void {
    if (!Number.isInteger(cycleId) || cycleId <= 0) {
      throw new Error("WHOOP cycle ID must be a positive integer");
    }
  }

  private assertActivityId(activityId: string): void {
    if (!z.string().uuid().safeParse(activityId).success) {
      throw new Error("WHOOP activity ID must be a UUID");
    }
  }
}
