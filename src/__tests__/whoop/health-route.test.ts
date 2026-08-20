import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../index";
import {
  getOpenApiDocument,
  whoopHealthCollectionQuerySchema,
} from "../../schemas/openapi";
import { WhoopHealthReadRepository } from "../../services/whoop/read-repository";
import type { Env } from "../../types/env";
import { ENV, bearerGet } from "./fixtures";

const emptyDatabase = {
  prepare: () => ({
    bind() { return this; },
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} }),
  }),
} as unknown as D1Database;

type SqliteStatement = {
  all: (...bindings: unknown[]) => unknown[];
  get: (...bindings: unknown[]) => unknown;
  run: (...bindings: unknown[]) => { changes: number | bigint };
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

class SqliteD1Statement {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, bindings);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null;
  }

  async all<T>() {
    return {
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      success: true,
      meta: {},
    };
  }
}

const sqliteD1 = (database: SqliteDatabase) => ({
  prepare: (sql: string) => new SqliteD1Statement(database, sql),
}) as unknown as D1Database;

const ACTIVE_CONNECTION_ID = "00000000-0000-4000-8000-000000000042";

const insertConnection = (database: SqliteDatabase) => database.prepare(`
  INSERT INTO whoop_connections (
    whoop_user_id, connection_id, status, granted_scopes, last_success_at,
    consecutive_failure_count, created_at, updated_at
  ) VALUES (42, ?, 'active', 'read:profile read:workout',
            '2026-08-20T11:59:00.000Z', 0,
            '2026-08-19T12:00:00.000Z', '2026-08-20T12:00:00.000Z')
`).run(ACTIVE_CONNECTION_ID);

const insertWorkout = (
  database: SqliteDatabase,
  overrides: {
    id?: string;
    startAt?: string;
    deletedAt?: string | null;
    scoreState?: string;
    kilojoules?: number | null;
    zoneZeroMilliseconds?: number | null;
  } = {},
) => database.prepare(`
  INSERT INTO whoop_workouts (
    workout_id, whoop_user_id, start_at, end_at, timezone_offset, sport_id, sport_name,
    score_state, strain, average_heart_rate, max_heart_rate, kilojoules, percent_recorded,
    distance_meter, elevation_gain_meter, zone_zero_milliseconds, zone_one_milliseconds,
    zone_two_milliseconds, zone_three_milliseconds, zone_four_milliseconds, zone_five_milliseconds,
    upstream_created_at, upstream_updated_at, deleted_at, synced_at, raw_json
  ) VALUES (?, 42, ?, '2026-08-20T11:30:00.000Z', '-04:00', 1, 'running',
            ?, 10.5, 155, 188, ?, 99.5, 5000, 75, ?, 2000, 3000, 4000, 5000, 6000,
            '2026-08-20T10:00:00.000Z', '2026-08-20T11:45:00.000Z', ?,
            '2026-08-20T11:46:00.000Z', '{"access_token":"must-never-leak"}')
`).run(
  overrides.id ?? "a2f0c3df-cdb4-48f8-a39b-221b5d8b7a34",
  overrides.startAt ?? "2026-08-20T10:30:00.000Z",
  overrides.scoreState ?? "SCORED",
  overrides.kilojoules === undefined ? 418.4 : overrides.kilojoules,
  overrides.zoneZeroMilliseconds === undefined ? 1499 : overrides.zoneZeroMilliseconds,
  overrides.deletedAt ?? null,
);

const insertCycle = (
  database: SqliteDatabase,
  cycleId: number,
  startAt: string,
  strain = 10,
) => database.prepare(`
  INSERT INTO whoop_cycles (
    cycle_id, whoop_user_id, start_at, end_at, timezone_offset, score_state,
    strain, upstream_created_at, upstream_updated_at, synced_at, raw_json
  ) VALUES (?, 42, ?, NULL, '+00:00', 'SCORED', ?, ?, ?, ?, '{}')
`).run(cycleId, startAt, strain, startAt, startAt, startAt);

const insertSleep = (
  database: SqliteDatabase,
  sleepId: string,
  cycleId: number,
  startAt: string,
) => database.prepare(`
  INSERT INTO whoop_sleeps (
    sleep_id, cycle_id, whoop_user_id, start_at, end_at, timezone_offset, nap,
    score_state, upstream_created_at, upstream_updated_at, synced_at, raw_json
  ) VALUES (?, ?, 42, ?, ?, '+00:00', 0, 'SCORED', ?, ?, ?, '{}')
`).run(sleepId, cycleId, startAt, startAt, startAt, startAt, startAt);

const insertCompleteSourceSet = (database: SqliteDatabase) => {
  database.prepare(`
    INSERT INTO whoop_profiles (
      whoop_user_id, first_name, last_name, email, upstream_created_at,
      upstream_updated_at, deleted_at, synced_at, raw_json
    ) VALUES (42, 'Fixture', 'User', 'fixture@whoop.test',
              '2026-08-01T00:00:00.000Z', '2026-08-20T11:55:00.000Z', NULL,
              '2026-08-20T11:56:00.000Z', '{"refresh_token":"must-never-leak"}')
  `).run();
  database.prepare(`
    INSERT INTO whoop_cycles (
      cycle_id, whoop_user_id, start_at, end_at, timezone_offset, score_state,
      strain, kilojoules, average_heart_rate, max_heart_rate, upstream_created_at,
      upstream_updated_at, deleted_at, synced_at, raw_json
    ) VALUES (9, 42, '2026-08-20T04:00:00.000Z', NULL, '-04:00', 'SCORED',
              12.3, 836.8, 75, 190, '2026-08-20T04:00:00.000Z',
              '2026-08-20T11:50:00.000Z', NULL, '2026-08-20T11:51:00.000Z', '{}')
  `).run();
  database.prepare(`
    INSERT INTO whoop_recoveries (
      sleep_id, cycle_id, whoop_user_id, score_state, user_calibrating,
      recovery_score, resting_heart_rate, hrv_rmssd_milliseconds, spo2_percentage,
      skin_temperature_celsius, upstream_created_at, upstream_updated_at,
      deleted_at, synced_at, raw_json
    ) VALUES ('f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c', 9, 42, 'PENDING_SCORE', 1,
              0, NULL, NULL, NULL, NULL, '2026-08-20T10:00:00.000Z',
              '2026-08-20T11:40:00.000Z', NULL, '2026-08-20T11:41:00.000Z', '{}')
  `).run();
  database.prepare(`
    INSERT INTO whoop_sleeps (
      sleep_id, cycle_id, whoop_user_id, start_at, end_at, timezone_offset, nap,
      score_state, stage_awake_milliseconds, stage_light_milliseconds,
      stage_slow_wave_milliseconds, stage_rem_milliseconds, stage_in_bed_milliseconds,
      stage_no_data_milliseconds, sleep_needed_milliseconds, sleep_debt_milliseconds,
      sleep_need_recent_strain_milliseconds, sleep_need_recent_nap_milliseconds,
      sleep_cycle_count, disturbance_count, sleep_efficiency_percentage,
      sleep_consistency_percentage, sleep_performance_percentage, respiratory_rate,
      upstream_created_at, upstream_updated_at, deleted_at, synced_at, raw_json
    ) VALUES ('f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c', 9, 42,
              '2026-08-20T03:00:00.000Z', '2026-08-20T10:00:00.000Z', '-04:00', 0,
              'SCORED', 1499, 7200000, 3600000, 5400000, 28800000, 60000,
              28800000, 1800000, 600000, -300000, 5, 9,
              91.2, 87.5, 84, 14.5, '2026-08-20T03:00:00.000Z',
              '2026-08-20T11:35:00.000Z', NULL, '2026-08-20T11:36:00.000Z', '{}')
  `).run();
};

describe("WHOOP health read routes", () => {
  it("mounts the overview behind bearer authentication", async () => {
    const env = { ...ENV, DB: emptyDatabase } as Env;

    const unauthorized = await worker.fetch(
      new Request("https://api.example.test/v1/health/whoop/overview"),
      env,
    );
    const authorized = await worker.fetch(
      new Request("https://api.example.test/v1/health/whoop/overview", bearerGet()),
      env,
    );

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      current_cycle: null,
      current_recovery: null,
      current_sleep: null,
      recent_workouts: [],
      trends_7_days: [],
      trends_30_days: [],
      synchronization: { status: "not_connected", progress: [], runs: [] },
    });
  });

  it("publishes exact protected OpenAPI contracts without replacing Apple routes", () => {
    const document = getOpenApiDocument("test");
    const serialized = JSON.stringify(document);
    const collectionPaths = ["cycles", "recoveries", "sleeps", "workouts"];

    for (const resource of collectionPaths) {
      const operation = document.paths?.[`/v1/health/whoop/${resource}`]?.get;
      expect(operation?.security).toEqual([{ bearerAuth: [] }]);
      expect(operation?.parameters?.map((parameter) => "name" in parameter ? parameter.name : null))
        .toEqual(["start", "end", "limit", "cursor"]);
      expect(operation?.responses).toHaveProperty("200");
      expect(operation?.responses).toHaveProperty("400");
      expect(operation?.responses).toHaveProperty("401");
    }
    for (const resource of ["overview", "profile"] as const) {
      expect(document.paths?.[`/v1/health/whoop/${resource}`]?.get?.security)
        .toEqual([{ bearerAuth: [] }]);
    }
    const detail = document.paths?.["/v1/health/whoop/workouts/{workoutId}"]?.get;
    expect(detail?.security).toEqual([{ bearerAuth: [] }]);
    expect(detail?.responses).toHaveProperty("404");
    expect(JSON.stringify(detail)).toContain("uuid");
    expect(document.paths).toHaveProperty("/v1/health");
    expect(document.paths).toHaveProperty("/v1/health/workouts/{id}");
    expect(serialized).toContain("energy_kcal_estimate");
    expect(serialized).toContain("hrv_rmssd_milliseconds");
    expect(serialized).toContain("stage_durations_seconds");
    expect(serialized).toContain("zone_durations_seconds");
    expect(serialized).not.toMatch(/raw_json|access_token_ciphertext|refresh_token_ciphertext|refresh_lease|webhook_signature/i);
  });

  describe("with WHOOP source rows", () => {
    let database: SqliteDatabase;
    let env: Env;

    beforeEach(async () => {
      // @ts-expect-error The Worker typecheck intentionally excludes Node test-runtime declarations.
      const { DatabaseSync } = await import("node:sqlite");
      // @ts-expect-error The Worker typecheck intentionally excludes Node test-runtime declarations.
      const { readFile } = await import("node:fs/promises");
      database = new DatabaseSync(":memory:") as SqliteDatabase;
      database.exec(await readFile("migrations/0020_whoop.sql", "utf8"));
      insertConnection(database);
      env = { ...ENV, DB: sqliteD1(database) } as Env;
    });

    afterEach(() => database.close());

    it("returns typed workout units without exposing stored source payloads", async () => {
      insertWorkout(database);

      const response = await worker.fetch(
        new Request("https://api.example.test/v1/health/whoop/workouts?limit=25", bearerGet()),
        env,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as { records: Record<string, unknown>[] };
      expect(body.records).toEqual([{
        workout_id: "a2f0c3df-cdb4-48f8-a39b-221b5d8b7a34",
        start_at: "2026-08-20T10:30:00.000Z",
        end_at: "2026-08-20T11:30:00.000Z",
        timezone_offset: "-04:00",
        sport_id: 1,
        sport_name: "running",
        score_state: "scored",
        strain: 10.5,
        average_heart_rate: 155,
        max_heart_rate: 188,
        kilojoules: 418.4,
        energy_kcal_estimate: 100,
        percent_recorded: 99.5,
        distance_meter: 5000,
        elevation_gain_meter: 75,
        zone_durations_seconds: {
          zone_zero_seconds: 1,
          zone_one_seconds: 2,
          zone_two_seconds: 3,
          zone_three_seconds: 4,
          zone_four_seconds: 5,
          zone_five_seconds: 6,
        },
        created_at: "2026-08-20T10:00:00.000Z",
        updated_at: "2026-08-20T11:45:00.000Z",
        synced_at: "2026-08-20T11:46:00.000Z",
      }]);
      expect(body).toHaveProperty("next_cursor", null);
      expect(JSON.stringify(body)).not.toMatch(/raw_json|access_token|ciphertext|nonce/i);
    });

    it("does not turn pending workout score fields into zero-valued health data", async () => {
      insertWorkout(database, {
        scoreState: "PENDING_SCORE",
        kilojoules: 0,
        zoneZeroMilliseconds: 0,
      });

      const response = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts",
        bearerGet(),
      ), env);
      expect(response.status).toBe(200);
      const body = await response.json() as { records: Record<string, unknown>[] };

      expect(body.records[0]).toMatchObject({
        score_state: "pending",
        strain: null,
        average_heart_rate: null,
        max_heart_rate: null,
        kilojoules: null,
        energy_kcal_estimate: null,
        percent_recorded: null,
        distance_meter: null,
        elevation_gain_meter: null,
        zone_durations_seconds: {
          zone_zero_seconds: null,
          zone_one_seconds: null,
          zone_two_seconds: null,
          zone_three_seconds: null,
          zone_four_seconds: null,
          zone_five_seconds: null,
        },
      });
    });

    it("uses stable tombstone-free keyset pagination when newer rows arrive", async () => {
      insertWorkout(database, {
        id: "00000000-0000-4000-8000-000000000003",
        startAt: "2026-08-20T10:00:00.000Z",
      });
      insertWorkout(database, {
        id: "00000000-0000-4000-8000-000000000002",
        startAt: "2026-08-20T10:00:00.000Z",
      });
      insertWorkout(database, {
        id: "00000000-0000-4000-8000-000000000001",
        startAt: "2026-08-20T10:00:00.000Z",
      });
      insertWorkout(database, {
        id: "00000000-0000-4000-8000-000000000099",
        startAt: "2026-08-20T12:00:00.000Z",
        deletedAt: "2026-08-20T12:01:00.000Z",
      });

      const firstResponse = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts?limit=1",
        bearerGet(),
      ), env);
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as {
        records: Array<{ workout_id: string }>;
        next_cursor: string | null;
      };
      expect(first.records.map((record) => record.workout_id)).toEqual([
        "00000000-0000-4000-8000-000000000003",
      ]);
      expect(first.next_cursor).toEqual(expect.any(String));

      insertWorkout(database, {
        id: "00000000-0000-4000-8000-000000000004",
        startAt: "2026-08-20T11:00:00.000Z",
      });
      const secondResponse = await worker.fetch(new Request(
        `https://api.example.test/v1/health/whoop/workouts?limit=1&cursor=${first.next_cursor}`,
        bearerGet(),
      ), env);
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json() as {
        records: Array<{ workout_id: string }>;
        next_cursor: string | null;
      };
      expect(second.records.map((record) => record.workout_id)).toEqual([
        "00000000-0000-4000-8000-000000000002",
      ]);
      expect(second.next_cursor).toEqual(expect.any(String));
    });

    it("orders, windows, and paginates offset timestamps by their instant", async () => {
      insertWorkout(database, {
        id: "00000000-0000-4000-8000-000000000003",
        startAt: "2026-08-20T10:00:00.000-04:00",
      });
      insertWorkout(database, {
        id: "00000000-0000-4000-8000-000000000002",
        startAt: "2026-08-20T13:00:00.000Z",
      });
      insertWorkout(database, {
        id: "00000000-0000-4000-8000-000000000001",
        startAt: "2026-08-20T12:00:00.000Z",
      });

      const firstResponse = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts?limit=1",
        bearerGet(),
      ), env);
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as {
        records: Array<{ workout_id: string }>;
        next_cursor: string;
      };
      expect(first.records.map((record) => record.workout_id)).toEqual([
        "00000000-0000-4000-8000-000000000003",
      ]);
      expect(first.next_cursor).toEqual(expect.any(String));

      const secondResponse = await worker.fetch(new Request(
        `https://api.example.test/v1/health/whoop/workouts?limit=1&cursor=${first.next_cursor}`,
        bearerGet(),
      ), env);
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json() as { records: Array<{ workout_id: string }> };
      expect(second.records.map((record) => record.workout_id)).toEqual([
        "00000000-0000-4000-8000-000000000002",
      ]);

      const windowResponse = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts?start=2026-08-20T14:00:00.000Z",
        bearerGet(),
      ), env);
      expect(windowResponse.status).toBe(200);
      const window = await windowResponse.json() as { records: Array<{ workout_id: string }> };
      expect(window.records.map((record) => record.workout_id)).toEqual([
        "00000000-0000-4000-8000-000000000003",
      ]);
    });

    it("validates date windows, limits, and bounded opaque cursors", async () => {
      for (const query of [
        "limit=0",
        "limit=101",
        "limit=1.5",
        "start=not-a-date",
        "end=2026-08-20",
        "start=2026-08-21T00:00:00.000Z&end=2026-08-20T00:00:00.000Z",
        `cursor=${"a".repeat(1025)}`,
        "cursor=not-base64!",
      ]) {
        const response = await worker.fetch(new Request(
          `https://api.example.test/v1/health/whoop/workouts?${query}`,
          bearerGet(),
        ), env);
        expect(response.status, query).toBe(400);
      }
    });

    it("uses the OpenAPI timestamp contract at runtime and rejects invalid calendar dates", async () => {
      for (const timestamp of [
        "2026-08-20T12:00:00",
        "2026-02-30T12:00:00.000Z",
      ]) {
        expect(whoopHealthCollectionQuerySchema.safeParse({ start: timestamp }).success, timestamp)
          .toBe(false);
        const response = await worker.fetch(new Request(
          `https://api.example.test/v1/health/whoop/workouts?start=${timestamp}`,
          bearerGet(),
        ), env);
        expect(response.status, timestamp).toBe(400);
      }
    });

    it("fails closed for missing or short cursor keys and rejects cursors after rotation", async () => {
      insertWorkout(database, { id: "00000000-0000-4000-8000-000000000002" });
      insertWorkout(database, { id: "00000000-0000-4000-8000-000000000001" });

      const missingKeyResponse = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts?limit=1",
        bearerGet(),
      ), { ...env, WHOOP_TOKEN_ENCRYPTION_KEY: undefined } as unknown as Env);
      const shortKeyResponse = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts?limit=1",
        bearerGet(),
      ), { ...env, WHOOP_TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" });
      const validKeyResponse = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts?limit=1",
        bearerGet(),
      ), env);

      expect(missingKeyResponse.status).toBe(500);
      expect(shortKeyResponse.status).toBe(500);
      expect(validKeyResponse.status).toBe(200);
      const { next_cursor: cursor } = await validKeyResponse.json() as { next_cursor: string };
      expect(cursor).toEqual(expect.any(String));

      const rotatedKeyResponse = await worker.fetch(new Request(
        `https://api.example.test/v1/health/whoop/workouts?limit=1&cursor=${cursor}`,
        bearerGet(),
      ), {
        ...env,
        WHOOP_TOKEN_ENCRYPTION_KEY: "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=",
      });
      expect(rotatedKeyResponse.status).toBe(400);
    });

    it("rejects tampered cursors and cursors reused with another window", async () => {
      insertWorkout(database, { id: "00000000-0000-4000-8000-000000000002" });
      insertWorkout(database, { id: "00000000-0000-4000-8000-000000000001" });
      const firstResponse = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts?limit=1",
        bearerGet(),
      ), env);
      expect(firstResponse.status).toBe(200);
      const { next_cursor: cursor } = await firstResponse.json() as { next_cursor: string };
      expect(cursor).toEqual(expect.any(String));
      const middle = Math.floor(cursor.length / 2);
      const replacement = cursor[middle] === "a" ? "b" : "a";
      const tampered = `${cursor.slice(0, middle)}${replacement}${cursor.slice(middle + 1)}`;

      const tamperedResponse = await worker.fetch(new Request(
        `https://api.example.test/v1/health/whoop/workouts?limit=1&cursor=${tampered}`,
        bearerGet(),
      ), env);
      const crossedWindowResponse = await worker.fetch(new Request(
        `https://api.example.test/v1/health/whoop/workouts?limit=1&start=2026-08-01T00:00:00.000Z&cursor=${cursor}`,
        bearerGet(),
      ), env);

      expect(tamperedResponse.status).toBe(400);
      expect(crossedWindowResponse.status).toBe(400);
    });

    it("returns exact typed cycles, recoveries, sleeps, and profile fields", async () => {
      insertCompleteSourceSet(database);

      const [cyclesResponse, recoveriesResponse, sleepsResponse, profileResponse] = await Promise.all([
        worker.fetch(new Request("https://api.example.test/v1/health/whoop/cycles", bearerGet()), env),
        worker.fetch(new Request("https://api.example.test/v1/health/whoop/recoveries", bearerGet()), env),
        worker.fetch(new Request("https://api.example.test/v1/health/whoop/sleeps", bearerGet()), env),
        worker.fetch(new Request("https://api.example.test/v1/health/whoop/profile", bearerGet()), env),
      ]);
      expect([
        cyclesResponse.status,
        recoveriesResponse.status,
        sleepsResponse.status,
        profileResponse.status,
      ]).toEqual([200, 200, 200, 200]);
      const cycles = await cyclesResponse.json() as { records: unknown[] };
      const recoveries = await recoveriesResponse.json() as { records: unknown[] };
      const sleeps = await sleepsResponse.json() as { records: unknown[] };

      expect(cycles.records).toEqual([{
        cycle_id: 9,
        start_at: "2026-08-20T04:00:00.000Z",
        end_at: null,
        timezone_offset: "-04:00",
        score_state: "scored",
        strain: 12.3,
        kilojoules: 836.8,
        energy_kcal_estimate: 200,
        average_heart_rate: 75,
        max_heart_rate: 190,
        created_at: "2026-08-20T04:00:00.000Z",
        updated_at: "2026-08-20T11:50:00.000Z",
        synced_at: "2026-08-20T11:51:00.000Z",
      }]);
      expect(recoveries.records).toEqual([{
        sleep_id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c",
        cycle_id: 9,
        score_state: "pending",
        user_calibrating: true,
        score: null,
        resting_heart_rate: null,
        hrv_rmssd_milliseconds: null,
        spo2_percentage: null,
        skin_temperature_celsius: null,
        created_at: "2026-08-20T10:00:00.000Z",
        updated_at: "2026-08-20T11:40:00.000Z",
        synced_at: "2026-08-20T11:41:00.000Z",
      }]);
      expect(sleeps.records).toEqual([{
        sleep_id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c",
        cycle_id: 9,
        start_at: "2026-08-20T03:00:00.000Z",
        end_at: "2026-08-20T10:00:00.000Z",
        timezone_offset: "-04:00",
        nap: false,
        score_state: "scored",
        stage_durations_seconds: {
          in_bed_seconds: 28800,
          awake_seconds: 1,
          no_data_seconds: 60,
          light_seconds: 7200,
          slow_wave_seconds: 3600,
          rem_seconds: 5400,
        },
        sleep_need_seconds: {
          baseline_seconds: 28800,
          debt_seconds: 1800,
          recent_strain_seconds: 600,
          recent_nap_seconds: -300,
        },
        sleep_cycle_count: 5,
        disturbance_count: 9,
        sleep_efficiency_percentage: 91.2,
        sleep_consistency_percentage: 87.5,
        sleep_performance_percentage: 84,
        respiratory_rate: 14.5,
        created_at: "2026-08-20T03:00:00.000Z",
        updated_at: "2026-08-20T11:35:00.000Z",
        synced_at: "2026-08-20T11:36:00.000Z",
      }]);
      expect(await profileResponse.json()).toEqual({
        whoop_user_id: 42,
        first_name: "Fixture",
        last_name: "User",
        email: "fixture@whoop.test",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-20T11:55:00.000Z",
        synced_at: "2026-08-20T11:56:00.000Z",
      });
    });

    it("validates workout UUIDs and returns 404 for missing or tombstoned detail", async () => {
      insertWorkout(database, {
        id: "00000000-0000-4000-8000-000000000001",
        deletedAt: "2026-08-20T12:00:00.000Z",
      });
      const malformed = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts/not-a-uuid",
        bearerGet(),
      ), env);
      const missing = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts/00000000-0000-4000-8000-000000000002",
        bearerGet(),
      ), env);
      const tombstoned = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts/00000000-0000-4000-8000-000000000001",
        bearerGet(),
      ), env);

      expect(malformed.status).toBe(400);
      expect(missing.status).toBe(404);
      expect(tombstoned.status).toBe(404);
    });

    it("rejects a valid workout cursor on a different collection", async () => {
      insertWorkout(database, { id: "00000000-0000-4000-8000-000000000002" });
      insertWorkout(database, { id: "00000000-0000-4000-8000-000000000001" });
      const firstResponse = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/workouts?limit=1",
        bearerGet(),
      ), env);
      const { next_cursor: cursor } = await firstResponse.json() as { next_cursor: string };

      const response = await worker.fetch(new Request(
        `https://api.example.test/v1/health/whoop/sleeps?limit=1&cursor=${cursor}`,
        bearerGet(),
      ), env);

      expect(response.status).toBe(400);
    });

    it("builds current state, bounded trends, recent workouts, and sanitized sync health", async () => {
      insertCompleteSourceSet(database);
      insertWorkout(database);
      database.prepare(`
        UPDATE whoop_connections
        SET last_error_at = '2026-08-20T11:58:00.000Z',
            last_error = 'access_token=must-never-leak'
        WHERE whoop_user_id = 42
      `).run();
      database.prepare(`
        INSERT INTO whoop_sync_checkpoints (
          whoop_user_id, connection_id, resource, mode, reconcile_generation,
          sync_run_id, target_id, status, page_count, record_count,
          created_at, updated_at, last_error
        ) VALUES (42, ?, 'workout', 'reconcile', 0,
                  '00000000-0000-4000-8000-000000000099', '', 'error', 2, 7,
                  '2026-08-20T11:00:00.000Z', '2026-08-20T11:57:00.000Z',
                  'refresh_token=must-never-leak')
      `).run(ACTIVE_CONNECTION_ID);

      const response = await worker.fetch(new Request(
        "https://api.example.test/v1/health/whoop/overview",
        bearerGet(),
      ), env);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;

      expect(body).toMatchObject({
        current_cycle: { cycle_id: 9, score_state: "scored", strain: 12.3 },
        current_recovery: {
          sleep_id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c",
          score_state: "pending",
          user_calibrating: true,
          score: null,
        },
        current_sleep: {
          sleep_id: "f7c85ce7-7e44-4bb4-8cb4-ee5b94b54e1c",
          sleep_performance_percentage: 84,
        },
        recent_workouts: [{
          workout_id: "a2f0c3df-cdb4-48f8-a39b-221b5d8b7a34",
        }],
        trends_7_days: [{
          date: "2026-08-20",
          recovery_score: null,
          strain: 12.3,
          sleep_performance_percentage: 84,
        }],
        trends_30_days: [{
          date: "2026-08-20",
          recovery_score: null,
          strain: 12.3,
          sleep_performance_percentage: 84,
        }],
        synchronization: {
          status: "active",
          last_success_at: "2026-08-20T11:59:00.000Z",
          last_error_at: "2026-08-20T11:58:00.000Z",
          consecutive_failure_count: 0,
          updated_at: "2026-08-20T12:00:00.000Z",
          progress: [{
            resource: "workout",
            mode: "reconcile",
            status: "error",
            page_count: 2,
            record_count: 7,
            updated_at: "2026-08-20T11:57:00.000Z",
          }],
          runs: [],
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/raw_json|access_token|refresh_token|ciphertext|nonce|lease|generation|connection_id/i);
    });

    it("does not pair the current cycle with an unrelated sleep when recovery is absent", async () => {
      insertCycle(database, 9, "2026-08-20T04:00:00.000Z");
      insertSleep(
        database,
        "00000000-0000-4000-8000-000000000008",
        8,
        "2026-08-20T03:00:00.000Z",
      );

      const repository = new WhoopHealthReadRepository(sqliteD1(database));
      const overview = await repository.getOverview(42, new Date("2026-08-20T12:00:00.000Z"));

      expect(overview.current_cycle?.cycle_id).toBe(9);
      expect(overview.current_recovery).toBeNull();
      expect(overview.current_sleep).toBeNull();
    });

    it("bounds trend dates to the current UTC calendar date and its prior 29 or 6 dates", async () => {
      insertCycle(database, 1, "2026-07-21T18:00:00.000Z");
      insertCycle(database, 2, "2026-07-22T00:00:00.000Z");
      insertCycle(database, 3, "2026-08-14T00:30:00.000+01:00");
      insertCycle(database, 4, "2026-08-14T00:00:00.000Z");
      insertCycle(database, 5, "2026-08-20T08:00:00.000Z");

      const repository = new WhoopHealthReadRepository(sqliteD1(database));
      const overview = await repository.getOverview(42, new Date("2026-08-20T18:00:00.000Z"));

      expect(overview.trends_30_days.map((point) => point.date)).toEqual([
        "2026-07-22",
        "2026-08-13",
        "2026-08-14",
        "2026-08-20",
      ]);
      expect(overview.trends_7_days.map((point) => point.date)).toEqual([
        "2026-08-14",
        "2026-08-20",
      ]);
    });
  });
});
