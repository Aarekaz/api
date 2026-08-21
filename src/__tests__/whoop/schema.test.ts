import { describe, expect, it } from "vitest";
import {
  whoopBodyMeasurementSchema,
  whoopCollectionQuerySchema,
  whoopCycleSchema,
  whoopProfileSchema,
  whoopRecoverySchema,
  whoopSleepSchema,
  whoopWebhookSchema,
  whoopWorkoutSchema,
} from "../../schemas/whoop";
import { WHOOP_SCOPES } from "../../types/whoop";
import {
  BODY_MEASUREMENT,
  CURRENT_CYCLE,
  CYCLE,
  ENV,
  PROFILE,
  RECOVERY,
  SLEEP,
  SLEEP_UPDATED,
  WORKOUT,
  signedWebhook,
} from "./fixtures";

const readProjectFile = async (path: string) => {
  // @ts-expect-error The Worker-only typecheck intentionally excludes Node test-runtime declarations.
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
};

describe("WHOOP shared schemas", () => {
  it("accepts the exact OAuth scopes and rejects an added scope", () => {
    expect(WHOOP_SCOPES).toEqual([
      "offline", "read:profile", "read:body_measurement", "read:cycles",
      "read:recovery", "read:sleep", "read:workout",
    ]);
    expect(whoopWebhookSchema.safeParse({
      user_id: 42,
      id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c",
      type: "sleep.updated",
      trace_id: "7b2dc91e-7423-42b1-a3cb-ecce1a0e2de8",
    }).success).toBe(true);
    expect(whoopWebhookSchema.safeParse({
      user_id: 42,
      id: "x",
      type: "sleep.created",
      trace_id: "t",
    }).success).toBe(false);
  });

  it("rejects an invalid local cursor and a limit above 100", () => {
    expect(whoopCollectionQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(whoopCollectionQuerySchema.safeParse({ cursor: "not-base64!" }).success).toBe(false);
    expect(whoopCollectionQuerySchema.safeParse({ cursor: "a" }).success).toBe(false);
    expect(whoopCollectionQuerySchema.safeParse({ cursor: "MTIzOjEyMzEyMw" }).success).toBe(true);
  });

  it("rejects unknown fields in strict local and webhook envelopes", () => {
    expect(whoopCollectionQuerySchema.safeParse({ limit: "25", untrusted: "value" }).success).toBe(false);
    expect(whoopWebhookSchema.safeParse({ ...SLEEP_UPDATED, untrusted: "value" }).success).toBe(false);
  });

  it("accepts official-shaped profile and body records without adding connection context", () => {
    expect(whoopProfileSchema.safeParse(PROFILE).success).toBe(true);
    expect(whoopBodyMeasurementSchema.safeParse(BODY_MEASUREMENT).success).toBe(true);
  });

  it("preserves provider extension fields", () => {
    const parsed = whoopBodyMeasurementSchema.parse({ ...BODY_MEASUREMENT, future_metric: 123 });
    expect(parsed.future_metric).toBe(123);
  });

  it("accepts a current cycle with a null end", () => {
    expect(whoopCycleSchema.safeParse(CURRENT_CYCLE).success).toBe(true);
  });

  it("accepts official-shaped cycle, sleep, and workout records", () => {
    expect(whoopCycleSchema.safeParse(CYCLE).success).toBe(true);
    expect(whoopSleepSchema.safeParse(SLEEP).success).toBe(true);
    expect(whoopWorkoutSchema.safeParse(WORKOUT).success).toBe(true);
  });

  it("retains every approved WHOOP v2 sleep detail in the typed schema", () => {
    const parsed = whoopSleepSchema.parse({
      ...SLEEP,
      score: {
        stage_summary: {
          total_in_bed_time_milli: 28_800_000,
          total_awake_time_milli: 1_800_000,
          total_no_data_time_milli: 60_000,
          total_light_sleep_time_milli: 14_400_000,
          total_slow_wave_sleep_time_milli: 6_000_000,
          total_rem_sleep_time_milli: 6_540_000,
          sleep_cycle_count: 5,
          disturbance_count: 9,
        },
        sleep_needed: {
          baseline_milli: 27_000_000,
          need_from_sleep_debt_milli: 900_000,
          need_from_recent_strain_milli: 600_000,
          need_from_recent_nap_milli: -300_000,
        },
      },
    });

    expect(parsed.score).toEqual(expect.objectContaining({
      stage_summary: expect.objectContaining({
        total_in_bed_time_milli: 28_800_000,
        total_no_data_time_milli: 60_000,
        sleep_cycle_count: 5,
        disturbance_count: 9,
      }),
      sleep_needed: expect.objectContaining({
        need_from_recent_strain_milli: 600_000,
        need_from_recent_nap_milli: -300_000,
      }),
    }));
    expect(whoopSleepSchema.safeParse({
      ...SLEEP,
      score: { stage_summary: { sleep_cycle_count: "five" } },
    }).success).toBe(false);
  });

  it("accepts official-shaped recovery records and preserves provider extensions", () => {
    const parsed = whoopRecoverySchema.parse({ ...RECOVERY, future_metric: 123 });
    expect(parsed.future_metric).toBe(123);
  });

  it("rejects provider records missing documented core fields", () => {
    const { email: _profileEmail, ...profileWithoutEmail } = PROFILE;
    const { timezone_offset: _cycleTimezone, ...cycleWithoutTimezone } = CYCLE;
    const { cycle_id: _recoveryCycle, ...recoveryWithoutCycle } = RECOVERY;
    const { nap: _sleepNap, ...sleepWithoutNap } = SLEEP;
    const { sport_name: _workoutSport, ...workoutWithoutSport } = WORKOUT;

    expect(whoopProfileSchema.safeParse(profileWithoutEmail).success).toBe(false);
    expect(whoopCycleSchema.safeParse(cycleWithoutTimezone).success).toBe(false);
    expect(whoopRecoverySchema.safeParse(recoveryWithoutCycle).success).toBe(false);
    expect(whoopSleepSchema.safeParse(sleepWithoutNap).success).toBe(false);
    expect(whoopWorkoutSchema.safeParse(workoutWithoutSport).success).toBe(false);
  });

  it("keeps the migration provider-only with nullable current-cycle ends and required checks", async () => {
    const migrationSql = await readProjectFile("migrations/0020_whoop.sql");
    const cyclesDefinition = migrationSql.match(/CREATE TABLE IF NOT EXISTS whoop_cycles \(([\s\S]*?)\n\);/)?.[1];
    const webhookDefinition = migrationSql.match(/CREATE TABLE IF NOT EXISTS whoop_webhook_events \(([\s\S]*?)\n\);/)?.[1];
    const connectionDefinition = migrationSql.match(/CREATE TABLE IF NOT EXISTS whoop_connections \(([\s\S]*?)\n\);/)?.[1];
    const seenDefinition = migrationSql.match(/CREATE TABLE IF NOT EXISTS whoop_reconcile_seen \(([\s\S]*?)\n\);/)?.[1];
    const checkpointDefinition = migrationSql.match(/CREATE TABLE IF NOT EXISTS whoop_sync_checkpoints \(([\s\S]*?)\n\);/)?.[1];

    expect(migrationSql).not.toMatch(/(?:ALTER|CREATE\s+TABLE)[\s\S]*apple_health_/i);
    expect(migrationSql).toMatch(/CREATE TABLE IF NOT EXISTS whoop_cycles/);
    expect(cyclesDefinition).toMatch(/end_at TEXT,/);
    expect(migrationSql).toMatch(/credential_version INTEGER NOT NULL DEFAULT 1/);
    expect(connectionDefinition).toMatch(/reconcile_generation INTEGER NOT NULL DEFAULT 0/);
    expect(migrationSql).toMatch(/initial_backfill_pending INTEGER NOT NULL DEFAULT 0/);
    expect(migrationSql).toMatch(/refresh_dispatched_at TEXT/);
    expect(migrationSql).toMatch(/status TEXT NOT NULL CHECK \(status IN/);
    expect(migrationSql).toMatch(/event_type TEXT NOT NULL CHECK \(event_type IN/);
    expect(webhookDefinition).toMatch(/connection_id TEXT NOT NULL/);
    expect(seenDefinition).toMatch(/reconcile_generation INTEGER NOT NULL/);
    expect(checkpointDefinition).toMatch(/sync_run_id TEXT NOT NULL/);
    expect(checkpointDefinition).toMatch(/target_id TEXT NOT NULL/);
    expect(checkpointDefinition).toMatch(/reconcile_generation INTEGER NOT NULL/);
    expect(checkpointDefinition).toMatch(
      /PRIMARY KEY \(whoop_user_id, connection_id, resource, mode, reconcile_generation, sync_run_id, target_id\)/,
    );
  });

  it("pins the deployment account and configures the serialized WHOOP queue binding", async () => {
    const wranglerToml = await readProjectFile("wrangler.toml");

    expect(wranglerToml).toMatch(/^account_id = "313c4e6e881f1e07c880d7230541200a"$/m);
    expect(wranglerToml).toMatch(/^WHOOP_REDIRECT_URI = "https:\/\/api\.anuragd\.me\/integrations\/whoop\/callback"$/m);
    expect(wranglerToml).toMatch(/^OS_BASE_URL = "https:\/\/os\.anuragd\.me"$/m);
    expect(wranglerToml).not.toMatch(/^WHOOP_(?:CLIENT_ID|CLIENT_SECRET|TOKEN_ENCRYPTION_KEY)\s*=/m);
    expect(wranglerToml).toMatch(/\[\[queues\.producers\]\][\s\S]*binding = "WHOOP_SYNC_QUEUE"[\s\S]*queue = "whoop-health-sync"/);
    expect(wranglerToml).toMatch(/\[\[queues\.consumers\]\][\s\S]*queue = "whoop-health-sync"[\s\S]*dead_letter_queue = "whoop-health-sync-dlq"[\s\S]*max_batch_size = 1[\s\S]*max_batch_timeout = 1[\s\S]*max_concurrency = 1[\s\S]*max_retries = 5/);
  });

  it("constructs a verifiable WHOOP HMAC over the timestamp and unmodified body", async () => {
    const requestInit = await signedWebhook(SLEEP_UPDATED);
    const headers = new Headers(requestInit.headers);
    const body = requestInit.body as string;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(ENV.WHOOP_CLIENT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signature = Uint8Array.from(atob(headers.get("X-WHOOP-Signature")!), (character) => character.charCodeAt(0));

    await expect(crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(headers.get("X-WHOOP-Signature-Timestamp")! + body),
    )).resolves.toBe(true);
  });
});
