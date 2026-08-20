import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../index";
import type { Env } from "../../types/env";
import { ENV, bearerGet } from "./fixtures";

type SqliteStatement = {
  all: (...bindings: unknown[]) => unknown[];
  run: (...bindings: unknown[]) => { changes: number | bigint };
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

class ExportD1Statement {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new ExportD1Statement(this.database, this.sql, bindings);
  }

  async all<T>() {
    if (!/\bFROM\s+whoop_/i.test(this.sql)) {
      return { results: [] as T[], success: true, meta: {} };
    }

    return {
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      success: true,
      meta: {},
    };
  }
}

const sqliteExportD1 = (database: SqliteDatabase) => ({
  prepare: (sql: string) => new ExportD1Statement(database, sql),
}) as unknown as D1Database;

describe("WHOOP export", () => {
  let database: SqliteDatabase;
  let env: Env;

  beforeEach(async () => {
    // @ts-expect-error The Worker typecheck intentionally excludes Node test-runtime declarations.
    const { DatabaseSync } = await import("node:sqlite");
    // @ts-expect-error The Worker typecheck intentionally excludes Node test-runtime declarations.
    const { readFile } = await import("node:fs/promises");
    database = new DatabaseSync(":memory:") as SqliteDatabase;
    database.exec(await readFile("migrations/0020_whoop.sql", "utf8"));
    env = { ...ENV, DB: sqliteExportD1(database) };

    database.exec(`
      INSERT INTO whoop_profiles (
        whoop_user_id, first_name, last_name, email, upstream_created_at,
        upstream_updated_at, deleted_at, synced_at, raw_json
      ) VALUES (
        42, 'Fixture', 'User', 'fixture@whoop.test',
        '2026-08-01T00:00:00.000Z', '2026-08-20T11:55:00.000Z', NULL,
        '2026-08-20T11:56:00.000Z', '{"refresh_token":"raw-profile-secret"}'
      );

      INSERT INTO whoop_body_measurements (
        whoop_user_id, height_meter, weight_kilogram, max_heart_rate,
        upstream_created_at, upstream_updated_at, deleted_at, synced_at, raw_json
      ) VALUES (
        42, 1.8, 75, 190, NULL, '2026-08-20T11:55:00.000Z', NULL,
        '2026-08-20T11:56:00.000Z', '{"access_token":"raw-body-secret"}'
      );

      INSERT INTO whoop_cycles (
        cycle_id, whoop_user_id, start_at, end_at, timezone_offset, score_state,
        strain, kilojoules, average_heart_rate, max_heart_rate,
        upstream_created_at, upstream_updated_at, deleted_at, synced_at, raw_json
      ) VALUES (
        9, 42, '2026-08-20T04:00:00.000Z', NULL, '-04:00', 'SCORED',
        12.3, 836.8, 75, 190, '2026-08-20T04:00:00.000Z',
        '2026-08-20T11:50:00.000Z', NULL, '2026-08-20T11:51:00.000Z',
        '{"signature":"raw-cycle-secret"}'
      );

      INSERT INTO whoop_recoveries (
        sleep_id, cycle_id, whoop_user_id, score_state, user_calibrating,
        recovery_score, resting_heart_rate, hrv_rmssd_milliseconds,
        spo2_percentage, skin_temperature_celsius, upstream_created_at,
        upstream_updated_at, deleted_at, synced_at, raw_json
      ) VALUES (
        '00000000-0000-4000-8000-000000000001', 9, 42, 'SCORED', 0,
        82, 52, 64, 97, 33.2, '2026-08-20T04:00:00.000Z',
        '2026-08-20T11:50:00.000Z', NULL, '2026-08-20T11:51:00.000Z',
        '{"nonce":"raw-recovery-secret"}'
      );

      INSERT INTO whoop_sleeps (
        sleep_id, cycle_id, whoop_user_id, start_at, end_at, timezone_offset,
        nap, score_state, stage_in_bed_milliseconds, stage_no_data_milliseconds,
        sleep_need_recent_strain_milliseconds, sleep_need_recent_nap_milliseconds,
        sleep_cycle_count, disturbance_count, sleep_efficiency_percentage, upstream_created_at,
        upstream_updated_at, deleted_at, synced_at, raw_json
      ) VALUES (
        '00000000-0000-4000-8000-000000000001', 9, 42,
        '2026-08-20T04:00:00.000Z', '2026-08-20T11:00:00.000Z', '-04:00',
        0, 'SCORED', 28800000, 60000, 600000, -300000, 5, 9, 91,
        '2026-08-20T04:00:00.000Z',
        '2026-08-20T11:50:00.000Z', NULL, '2026-08-20T11:51:00.000Z',
        '{"last_error":"raw-sleep-secret"}'
      );

      INSERT INTO whoop_workouts (
        workout_id, whoop_user_id, start_at, end_at, timezone_offset, sport_id,
        sport_name, score_state, strain, kilojoules, upstream_created_at,
        upstream_updated_at, deleted_at, synced_at, raw_json
      ) VALUES (
        '00000000-0000-4000-8000-000000000002', 42,
        '2026-08-19T10:00:00.000Z', '2026-08-19T11:00:00.000Z', '-04:00', 1,
        'running', 'SCORED', 10, 418.4, '2026-08-19T10:00:00.000Z',
        '2026-08-19T11:00:00.000Z', '2026-08-20T12:00:00.000Z',
        '2026-08-20T12:01:00.000Z', '{"ciphertext":"raw-workout-secret"}'
      );

      INSERT INTO whoop_connections (
        whoop_user_id, connection_id, status, access_token_ciphertext,
        access_token_nonce, refresh_token_ciphertext, refresh_token_nonce,
        granted_scopes, last_error, created_at, updated_at
      ) VALUES (
        42, '00000000-0000-4000-8000-000000000042', 'active',
        'operational-access-ciphertext', 'operational-access-nonce',
        'operational-refresh-ciphertext', 'operational-refresh-nonce',
        'offline read:profile', 'operational-error',
        '2026-08-19T12:00:00.000Z', '2026-08-20T12:00:00.000Z'
      );

      INSERT INTO whoop_oauth_states (state_hash, created_at, expires_at)
      VALUES ('operational-state-hash', '2026-08-20T11:00:00.000Z', '2026-08-20T11:10:00.000Z');

      INSERT INTO whoop_webhook_events (
        trace_id, whoop_user_id, connection_id, resource_id, event_type,
        received_at, status, last_error
      ) VALUES (
        'operational-trace', 42, '00000000-0000-4000-8000-000000000042',
        '00000000-0000-4000-8000-000000000002', 'workout.updated',
        '2026-08-20T12:00:00.000Z', 'received', 'operational-webhook-error'
      );
    `);
  });

  afterEach(() => database.close());

  it("exports only explicit WHOOP source projections, including tombstones", async () => {
    const response = await worker.fetch(
      new Request("https://api.example.test/v1/export", bearerGet()),
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.whoop).toMatchObject({
      profiles: [{ whoop_user_id: 42, first_name: "Fixture" }],
      body_measurements: [{ whoop_user_id: 42, weight_kilogram: 75 }],
      cycles: [{ cycle_id: 9, kilojoules: 836.8 }],
      recoveries: [{ cycle_id: 9, recovery_score: 82 }],
      sleeps: [{
        cycle_id: 9,
        stage_in_bed_milliseconds: 28800000,
        stage_no_data_milliseconds: 60000,
        sleep_need_recent_strain_milliseconds: 600000,
        sleep_need_recent_nap_milliseconds: -300000,
        sleep_cycle_count: 5,
        disturbance_count: 9,
        sleep_efficiency_percentage: 91,
      }],
      workouts: [{
        workout_id: "00000000-0000-4000-8000-000000000002",
        deleted_at: "2026-08-20T12:00:00.000Z",
      }],
    });

    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "raw_json",
      "whoop_connections",
      "whoop_oauth_states",
      "whoop_webhook_events",
      "whoop_sync_checkpoints",
      "whoop_sync_runs",
      "ciphertext",
      "nonce",
      "signature",
      "last_error",
      "operational-",
      "raw-",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
