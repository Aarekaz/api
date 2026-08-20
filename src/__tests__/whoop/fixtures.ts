import { vi } from "vitest";
import type { Env } from "../../types/env";
import type { WhoopQueueMessage, WhoopWebhookEvent } from "../../types/whoop";

export const NOW = "2026-08-19T12:00:00.000Z";
export const NOW_MS = String(Date.parse(NOW));
export const NOW_MINUS_SIX_MINUTES_MS = String(Date.parse(NOW) - 6 * 60 * 1000);
export const CONNECTION_ID = "00000000-0000-4000-8000-000000000042";
export const PROFILE = { user_id: 42, email: "fixture@whoop.test", first_name: "Fixture", last_name: "User" };
export const BODY_MEASUREMENT = { height_meter: 1.8, weight_kilogram: 75, max_heart_rate: 190 };
export const CYCLE = {
  id: 9,
  user_id: 42,
  created_at: NOW,
  updated_at: NOW,
  start: "2026-08-19T08:00:00.000Z",
  end: "2026-08-19T10:00:00.000Z",
  timezone_offset: "-04:00",
  score_state: "SCORED",
} as const;
export const CURRENT_CYCLE = { ...CYCLE, end: null };
export const RECOVERY = {
  sleep_id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c",
  cycle_id: 9,
  user_id: 42,
  created_at: NOW,
  updated_at: NOW,
  score_state: "SCORED",
} as const;
export const SLEEP = {
  id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c",
  cycle_id: 9,
  user_id: 42,
  created_at: NOW,
  updated_at: NOW,
  start: "2026-08-19T04:00:00.000Z",
  end: "2026-08-19T11:00:00.000Z",
  timezone_offset: "-04:00",
  nap: false,
  score_state: "SCORED",
} as const;
export const WORKOUT = {
  id: "a2f0c3df-cdb4-48f8-a39b-221b5d8b7a34",
  user_id: 42,
  created_at: NOW,
  updated_at: NOW,
  start: "2026-08-19T10:30:00.000Z",
  end: "2026-08-19T11:30:00.000Z",
  timezone_offset: "-04:00",
  sport_name: "running",
  score_state: "SCORED",
} as const;
export const SLEEP_UPDATED = { user_id: 42, id: SLEEP.id, type: "sleep.updated", trace_id: "7b2dc91e-7423-42b1-a3cb-ecce1a0e2de8" } as const;
export const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

export const bearerGet = () => ({ headers: { Authorization: "Bearer test-api-token" } });
export const bearerPost = () => ({ method: "POST", headers: { Authorization: "Bearer test-api-token" } });
export const jsonResponse = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
  ...init,
});

type FixtureQueueMessage = WhoopQueueMessage extends infer Message
  ? Message extends WhoopQueueMessage
    ? Omit<Message, "connectionId"> & { connectionId?: string }
    : never
  : never;

export const batchOf = (message: FixtureQueueMessage) => ({
  messages: [{ body: { connectionId: CONNECTION_ID, ...message }, ack: vi.fn(), retry: vi.fn() }],
}) as unknown as MessageBatch<WhoopQueueMessage>;

const TEST_WHOOP_CLIENT_SECRET = "test-whoop-client-secret";
const encoder = new TextEncoder();

const bytesToBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export const signedWebhook = async (
  payload: WhoopWebhookEvent,
  timestamp = NOW_MS,
): Promise<RequestInit> => {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(TEST_WHOOP_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp + body));

  return {
    method: "POST",
    body,
    headers: {
      "X-WHOOP-Signature": bytesToBase64(new Uint8Array(signature)),
      "X-WHOOP-Signature-Timestamp": timestamp,
      "content-type": "application/json",
    },
  };
};

export const ENV: Env = {
  DB: {} as D1Database,
  R2_BUCKET: {} as R2Bucket,
  API_TOKEN: "test-api-token",
  WHOOP_CLIENT_ID: "test-whoop-client-id",
  WHOOP_CLIENT_SECRET: TEST_WHOOP_CLIENT_SECRET,
  WHOOP_TOKEN_ENCRYPTION_KEY: KEY,
  WHOOP_REDIRECT_URI: "https://api.example.test/integrations/whoop/callback",
  OS_BASE_URL: "https://os.example.test",
  WHOOP_SYNC_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue<WhoopQueueMessage>,
  LANYARD_USER_ID: "test-lanyard-user-id",
  WAKATIME_API_KEY: "test-wakatime-api-key",
  WAKATIME_TIMEZONE: "America/New_York",
  GITHUB_USERNAME: "test-github-username",
  GITHUB_TOKEN: "test-github-token",
  API_VERSION: "test",
  R2_PUBLIC_BASE_URL: "https://media.example.test",
};
