export type WhoopReadScoreState = "scored" | "pending" | "unscorable";

export interface WhoopWorkoutReadModel {
  workout_id: string;
  start_at: string | null;
  end_at: string | null;
  timezone_offset: string | null;
  sport_id: number | null;
  sport_name: string | null;
  score_state: WhoopReadScoreState;
  strain: number | null;
  average_heart_rate: number | null;
  max_heart_rate: number | null;
  kilojoules: number | null;
  energy_kcal_estimate: number | null;
  percent_recorded: number | null;
  distance_meter: number | null;
  elevation_gain_meter: number | null;
  zone_durations_seconds: {
    zone_zero_seconds: number | null;
    zone_one_seconds: number | null;
    zone_two_seconds: number | null;
    zone_three_seconds: number | null;
    zone_four_seconds: number | null;
    zone_five_seconds: number | null;
  };
  created_at: string;
  updated_at: string;
  synced_at: string;
}

export interface WhoopCycleReadModel {
  cycle_id: number;
  start_at: string;
  end_at: string | null;
  timezone_offset: string | null;
  score_state: WhoopReadScoreState;
  strain: number | null;
  kilojoules: number | null;
  energy_kcal_estimate: number | null;
  average_heart_rate: number | null;
  max_heart_rate: number | null;
  created_at: string;
  updated_at: string;
  synced_at: string;
}

export interface WhoopRecoveryReadModel {
  sleep_id: string;
  cycle_id: number;
  score_state: WhoopReadScoreState;
  user_calibrating: boolean | null;
  score: number | null;
  resting_heart_rate: number | null;
  hrv_rmssd_milliseconds: number | null;
  spo2_percentage: number | null;
  skin_temperature_celsius: number | null;
  created_at: string;
  updated_at: string;
  synced_at: string;
}

export interface WhoopSleepReadModel {
  sleep_id: string;
  cycle_id: number;
  start_at: string | null;
  end_at: string | null;
  timezone_offset: string | null;
  nap: boolean | null;
  score_state: WhoopReadScoreState;
  stage_durations_seconds: {
    awake_seconds: number | null;
    light_seconds: number | null;
    slow_wave_seconds: number | null;
    rem_seconds: number | null;
  };
  sleep_need_seconds: {
    baseline_seconds: number | null;
    debt_seconds: number | null;
  };
  sleep_efficiency_percentage: number | null;
  sleep_consistency_percentage: number | null;
  sleep_performance_percentage: number | null;
  respiratory_rate: number | null;
  created_at: string;
  updated_at: string;
  synced_at: string;
}

export interface WhoopProfileReadModel {
  whoop_user_id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  created_at: string | null;
  updated_at: string | null;
  synced_at: string;
}

export interface WhoopTrendPoint {
  date: string;
  recovery_score: number | null;
  strain: number | null;
  sleep_performance_percentage: number | null;
}

export interface WhoopOverviewReadModel {
  current_cycle: WhoopCycleReadModel | null;
  current_recovery: WhoopRecoveryReadModel | null;
  current_sleep: WhoopSleepReadModel | null;
  recent_workouts: WhoopWorkoutReadModel[];
  trends_7_days: WhoopTrendPoint[];
  trends_30_days: WhoopTrendPoint[];
}

export interface WhoopReadContext {
  whoopUserId: number;
  status: "connecting" | "backfilling" | "active" | "needs_reauth" | "disconnected" | "error";
  last_success_at: string | null;
  last_error_at: string | null;
  consecutive_failure_count: number;
  updated_at: string;
  progress: Array<{
    resource: "profile" | "body_measurement" | "cycle" | "recovery" | "sleep" | "workout";
    mode: "backfill" | "reconcile" | "webhook";
    status: "queued" | "running" | "retrying" | "complete" | "failed" | "error";
    page_count: number;
    record_count: number;
    updated_at: string;
  }>;
}

export interface WhoopReadPage<T> {
  records: T[];
  nextAnchor: { sortAt: string; id: string } | null;
}

interface WorkoutRow {
  workout_id: string;
  start_at: string | null;
  end_at: string | null;
  timezone_offset: string | null;
  sport_id: number | null;
  sport_name: string | null;
  score_state: string;
  strain: number | null;
  average_heart_rate: number | null;
  max_heart_rate: number | null;
  kilojoules: number | null;
  percent_recorded: number | null;
  distance_meter: number | null;
  elevation_gain_meter: number | null;
  zone_zero_milliseconds: number | null;
  zone_one_milliseconds: number | null;
  zone_two_milliseconds: number | null;
  zone_three_milliseconds: number | null;
  zone_four_milliseconds: number | null;
  zone_five_milliseconds: number | null;
  upstream_created_at: string;
  upstream_updated_at: string;
  synced_at: string;
  sort_at: string;
}

interface CycleRow {
  cycle_id: number;
  start_at: string;
  end_at: string | null;
  timezone_offset: string | null;
  score_state: string;
  strain: number | null;
  kilojoules: number | null;
  average_heart_rate: number | null;
  max_heart_rate: number | null;
  upstream_created_at: string;
  upstream_updated_at: string;
  synced_at: string;
  sort_at: string;
}

interface RecoveryRow {
  sleep_id: string;
  cycle_id: number;
  score_state: string;
  user_calibrating: number | null;
  recovery_score: number | null;
  resting_heart_rate: number | null;
  hrv_rmssd_milliseconds: number | null;
  spo2_percentage: number | null;
  skin_temperature_celsius: number | null;
  upstream_created_at: string;
  upstream_updated_at: string;
  synced_at: string;
  sort_at: string;
}

interface SleepRow {
  sleep_id: string;
  cycle_id: number;
  start_at: string | null;
  end_at: string | null;
  timezone_offset: string | null;
  nap: number | null;
  score_state: string;
  stage_awake_milliseconds: number | null;
  stage_light_milliseconds: number | null;
  stage_slow_wave_milliseconds: number | null;
  stage_rem_milliseconds: number | null;
  sleep_needed_milliseconds: number | null;
  sleep_debt_milliseconds: number | null;
  sleep_efficiency_percentage: number | null;
  sleep_consistency_percentage: number | null;
  sleep_performance_percentage: number | null;
  respiratory_rate: number | null;
  upstream_created_at: string;
  upstream_updated_at: string;
  synced_at: string;
  sort_at: string;
}

interface CollectionOptions {
  start: string | null;
  end: string | null;
  limit: number;
  cursor: { sortAt: string; id: string } | null;
}

const scoreState = (value: string): WhoopReadScoreState => {
  if (value === "SCORED") return "scored";
  if (value === "PENDING_SCORE") return "pending";
  return "unscorable";
};

const seconds = (milliseconds: number | null): number | null =>
  milliseconds === null ? null : Math.round(milliseconds / 1_000);

const kcalEstimate = (kilojoules: number | null): number | null =>
  kilojoules === null ? null : Math.round((kilojoules / 4.184) * 100) / 100;

const scoredValue = <T>(state: string, value: T | null): T | null =>
  state === "SCORED" ? value : null;

const workoutReadModel = (row: WorkoutRow): WhoopWorkoutReadModel => {
  const kilojoules = scoredValue(row.score_state, row.kilojoules);
  return {
    workout_id: row.workout_id,
    start_at: row.start_at,
    end_at: row.end_at,
    timezone_offset: row.timezone_offset,
    sport_id: row.sport_id,
    sport_name: row.sport_name,
    score_state: scoreState(row.score_state),
    strain: scoredValue(row.score_state, row.strain),
    average_heart_rate: scoredValue(row.score_state, row.average_heart_rate),
    max_heart_rate: scoredValue(row.score_state, row.max_heart_rate),
    kilojoules,
    energy_kcal_estimate: kcalEstimate(kilojoules),
    percent_recorded: scoredValue(row.score_state, row.percent_recorded),
    distance_meter: scoredValue(row.score_state, row.distance_meter),
    elevation_gain_meter: scoredValue(row.score_state, row.elevation_gain_meter),
    zone_durations_seconds: {
      zone_zero_seconds: seconds(scoredValue(row.score_state, row.zone_zero_milliseconds)),
      zone_one_seconds: seconds(scoredValue(row.score_state, row.zone_one_milliseconds)),
      zone_two_seconds: seconds(scoredValue(row.score_state, row.zone_two_milliseconds)),
      zone_three_seconds: seconds(scoredValue(row.score_state, row.zone_three_milliseconds)),
      zone_four_seconds: seconds(scoredValue(row.score_state, row.zone_four_milliseconds)),
      zone_five_seconds: seconds(scoredValue(row.score_state, row.zone_five_milliseconds)),
    },
    created_at: row.upstream_created_at,
    updated_at: row.upstream_updated_at,
    synced_at: row.synced_at,
  };
};

const cycleReadModel = (row: CycleRow): WhoopCycleReadModel => ({
  cycle_id: row.cycle_id,
  start_at: row.start_at,
  end_at: row.end_at,
  timezone_offset: row.timezone_offset,
  score_state: scoreState(row.score_state),
  strain: scoredValue(row.score_state, row.strain),
  kilojoules: scoredValue(row.score_state, row.kilojoules),
  energy_kcal_estimate: kcalEstimate(scoredValue(row.score_state, row.kilojoules)),
  average_heart_rate: scoredValue(row.score_state, row.average_heart_rate),
  max_heart_rate: scoredValue(row.score_state, row.max_heart_rate),
  created_at: row.upstream_created_at,
  updated_at: row.upstream_updated_at,
  synced_at: row.synced_at,
});

const recoveryReadModel = (row: RecoveryRow): WhoopRecoveryReadModel => ({
  sleep_id: row.sleep_id,
  cycle_id: row.cycle_id,
  score_state: scoreState(row.score_state),
  user_calibrating: row.user_calibrating === null ? null : row.user_calibrating === 1,
  score: scoredValue(row.score_state, row.recovery_score),
  resting_heart_rate: scoredValue(row.score_state, row.resting_heart_rate),
  hrv_rmssd_milliseconds: scoredValue(row.score_state, row.hrv_rmssd_milliseconds),
  spo2_percentage: scoredValue(row.score_state, row.spo2_percentage),
  skin_temperature_celsius: scoredValue(row.score_state, row.skin_temperature_celsius),
  created_at: row.upstream_created_at,
  updated_at: row.upstream_updated_at,
  synced_at: row.synced_at,
});

const sleepReadModel = (row: SleepRow): WhoopSleepReadModel => ({
  sleep_id: row.sleep_id,
  cycle_id: row.cycle_id,
  start_at: row.start_at,
  end_at: row.end_at,
  timezone_offset: row.timezone_offset,
  nap: row.nap === null ? null : row.nap === 1,
  score_state: scoreState(row.score_state),
  stage_durations_seconds: {
    awake_seconds: seconds(scoredValue(row.score_state, row.stage_awake_milliseconds)),
    light_seconds: seconds(scoredValue(row.score_state, row.stage_light_milliseconds)),
    slow_wave_seconds: seconds(scoredValue(row.score_state, row.stage_slow_wave_milliseconds)),
    rem_seconds: seconds(scoredValue(row.score_state, row.stage_rem_milliseconds)),
  },
  sleep_need_seconds: {
    baseline_seconds: seconds(scoredValue(row.score_state, row.sleep_needed_milliseconds)),
    debt_seconds: seconds(scoredValue(row.score_state, row.sleep_debt_milliseconds)),
  },
  sleep_efficiency_percentage: scoredValue(row.score_state, row.sleep_efficiency_percentage),
  sleep_consistency_percentage: scoredValue(row.score_state, row.sleep_consistency_percentage),
  sleep_performance_percentage: scoredValue(row.score_state, row.sleep_performance_percentage),
  respiratory_rate: scoredValue(row.score_state, row.respiratory_rate),
  created_at: row.upstream_created_at,
  updated_at: row.upstream_updated_at,
  synced_at: row.synced_at,
});

export class WhoopHealthReadRepository {
  constructor(private readonly db: D1Database) {}

  async getReadContext(): Promise<WhoopReadContext | null> {
    const connection = await this.db.prepare(`
      SELECT whoop_user_id, status, last_success_at, last_error_at,
             consecutive_failure_count, updated_at
      FROM whoop_connections
      ORDER BY CASE WHEN status = 'disconnected' THEN 1 ELSE 0 END,
               connected_at DESC, whoop_user_id DESC
      LIMIT 1
    `).first<{
      whoop_user_id: number;
      status: WhoopReadContext["status"];
      last_success_at: string | null;
      last_error_at: string | null;
      consecutive_failure_count: number;
      updated_at: string;
    }>();
    if (!connection) return null;
    const progress = await this.db.prepare(`
      SELECT resource, mode, status, page_count, record_count, updated_at
      FROM (
        SELECT checkpoint.resource, checkpoint.mode, checkpoint.status,
               checkpoint.page_count, checkpoint.record_count, checkpoint.updated_at,
               ROW_NUMBER() OVER (
                 PARTITION BY checkpoint.resource, checkpoint.mode
                 ORDER BY checkpoint.reconcile_generation DESC,
                          checkpoint.created_at DESC,
                          checkpoint.page_count DESC,
                          checkpoint.record_count DESC
               ) AS row_number
        FROM whoop_sync_checkpoints AS checkpoint
        INNER JOIN whoop_connections AS current_connection
          ON current_connection.whoop_user_id = checkpoint.whoop_user_id
         AND current_connection.connection_id = checkpoint.connection_id
        WHERE checkpoint.whoop_user_id = ? AND checkpoint.target_id = ''
      )
      WHERE row_number = 1
      ORDER BY resource ASC, mode ASC
    `).bind(connection.whoop_user_id).all<WhoopReadContext["progress"][number]>();
    return {
      whoopUserId: connection.whoop_user_id,
      status: connection.status,
      last_success_at: connection.last_success_at,
      last_error_at: connection.last_error_at,
      consecutive_failure_count: connection.consecutive_failure_count,
      updated_at: connection.updated_at,
      progress: progress.results,
    };
  }

  private async listRows<T extends { sort_at: string }>(input: {
    table: string;
    columns: string;
    keyColumn: string;
    timeExpression: string;
    whoopUserId: number;
    options: CollectionOptions;
  }): Promise<{ rows: T[]; nextAnchor: { sortAt: string; id: string } | null }> {
    const instantExpression = `julianday(${input.timeExpression})`;
    const canonicalSortExpression = `strftime('%Y-%m-%dT%H:%M:%fZ', ${input.timeExpression})`;
    const filters = ["whoop_user_id = ?", "deleted_at IS NULL"];
    const bindings: unknown[] = [input.whoopUserId];
    if (input.options.start !== null) {
      filters.push(`${instantExpression} >= julianday(?)`);
      bindings.push(input.options.start);
    }
    if (input.options.end !== null) {
      filters.push(`${instantExpression} <= julianday(?)`);
      bindings.push(input.options.end);
    }
    if (input.options.cursor !== null) {
      filters.push(`(${instantExpression} < julianday(?) OR (${instantExpression} = julianday(?) AND ${input.keyColumn} < ?))`);
      bindings.push(
        input.options.cursor.sortAt,
        input.options.cursor.sortAt,
        input.keyColumn === "cycle_id" ? Number(input.options.cursor.id) : input.options.cursor.id,
      );
    }
    bindings.push(input.options.limit + 1);
    const result = await this.db.prepare(`
      SELECT ${input.columns}, ${canonicalSortExpression} AS sort_at
      FROM ${input.table}
      WHERE ${filters.join(" AND ")}
      ORDER BY ${instantExpression} DESC, ${input.keyColumn} DESC
      LIMIT ?
    `).bind(...bindings).all<T & Record<string, unknown>>();
    const rows = result.results.slice(0, input.options.limit) as T[];
    const last = rows.at(-1) as (T & Record<string, unknown>) | undefined;
    return {
      rows,
      nextAnchor: result.results.length > input.options.limit && last
        ? { sortAt: last.sort_at, id: String(last[input.keyColumn]) }
        : null,
    };
  }

  async listCycles(
    whoopUserId: number,
    options: CollectionOptions,
  ): Promise<WhoopReadPage<WhoopCycleReadModel>> {
    const page = await this.listRows<CycleRow>({
      table: "whoop_cycles",
      columns: `cycle_id, start_at, end_at, timezone_offset, score_state, strain,
                kilojoules, average_heart_rate, max_heart_rate, upstream_created_at,
                upstream_updated_at, synced_at`,
      keyColumn: "cycle_id",
      timeExpression: "start_at",
      whoopUserId,
      options,
    });
    return { records: page.rows.map(cycleReadModel), nextAnchor: page.nextAnchor };
  }

  async listRecoveries(
    whoopUserId: number,
    options: CollectionOptions,
  ): Promise<WhoopReadPage<WhoopRecoveryReadModel>> {
    const page = await this.listRows<RecoveryRow>({
      table: "whoop_recoveries",
      columns: `sleep_id, cycle_id, score_state, user_calibrating, recovery_score,
                resting_heart_rate, hrv_rmssd_milliseconds, spo2_percentage,
                skin_temperature_celsius, upstream_created_at, upstream_updated_at, synced_at`,
      keyColumn: "sleep_id",
      timeExpression: "upstream_created_at",
      whoopUserId,
      options,
    });
    return { records: page.rows.map(recoveryReadModel), nextAnchor: page.nextAnchor };
  }

  async listSleeps(
    whoopUserId: number,
    options: CollectionOptions,
  ): Promise<WhoopReadPage<WhoopSleepReadModel>> {
    const page = await this.listRows<SleepRow>({
      table: "whoop_sleeps",
      columns: `sleep_id, cycle_id, start_at, end_at, timezone_offset, nap, score_state,
                stage_awake_milliseconds, stage_light_milliseconds, stage_slow_wave_milliseconds,
                stage_rem_milliseconds, sleep_needed_milliseconds, sleep_debt_milliseconds,
                sleep_efficiency_percentage, sleep_consistency_percentage,
                sleep_performance_percentage, respiratory_rate, upstream_created_at,
                upstream_updated_at, synced_at`,
      keyColumn: "sleep_id",
      timeExpression: "COALESCE(start_at, upstream_created_at)",
      whoopUserId,
      options,
    });
    return { records: page.rows.map(sleepReadModel), nextAnchor: page.nextAnchor };
  }

  async listWorkouts(
    whoopUserId: number,
    options: CollectionOptions,
  ): Promise<WhoopReadPage<WhoopWorkoutReadModel>> {
    const page = await this.listRows<WorkoutRow>({
      table: "whoop_workouts",
      columns: `workout_id, start_at, end_at, timezone_offset, sport_id, sport_name,
                score_state, strain, average_heart_rate, max_heart_rate, kilojoules,
                percent_recorded, distance_meter, elevation_gain_meter,
                zone_zero_milliseconds, zone_one_milliseconds, zone_two_milliseconds,
                zone_three_milliseconds, zone_four_milliseconds, zone_five_milliseconds,
                upstream_created_at, upstream_updated_at, synced_at`,
      keyColumn: "workout_id",
      timeExpression: "COALESCE(start_at, upstream_created_at)",
      whoopUserId,
      options,
    });
    return { records: page.rows.map(workoutReadModel), nextAnchor: page.nextAnchor };
  }

  async getWorkout(whoopUserId: number, workoutId: string): Promise<WhoopWorkoutReadModel | null> {
    const row = await this.db.prepare(`
      SELECT workout_id, start_at, end_at, timezone_offset, sport_id, sport_name,
             score_state, strain, average_heart_rate, max_heart_rate, kilojoules,
             percent_recorded, distance_meter, elevation_gain_meter,
             zone_zero_milliseconds, zone_one_milliseconds, zone_two_milliseconds,
             zone_three_milliseconds, zone_four_milliseconds, zone_five_milliseconds,
             upstream_created_at, upstream_updated_at, synced_at,
             COALESCE(start_at, upstream_created_at) AS sort_at
      FROM whoop_workouts
      WHERE whoop_user_id = ? AND workout_id = ? AND deleted_at IS NULL
    `).bind(whoopUserId, workoutId).first<WorkoutRow>();
    return row ? workoutReadModel(row) : null;
  }

  async getProfile(whoopUserId: number): Promise<WhoopProfileReadModel | null> {
    const row = await this.db.prepare(`
      SELECT whoop_user_id, first_name, last_name, email, upstream_created_at,
             upstream_updated_at, synced_at
      FROM whoop_profiles
      WHERE whoop_user_id = ? AND deleted_at IS NULL
    `).bind(whoopUserId).first<{
      whoop_user_id: number;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      upstream_created_at: string | null;
      upstream_updated_at: string | null;
      synced_at: string;
    }>();
    return row ? {
      whoop_user_id: row.whoop_user_id,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      created_at: row.upstream_created_at,
      updated_at: row.upstream_updated_at,
      synced_at: row.synced_at,
    } : null;
  }

  async getOverview(whoopUserId: number, now: Date): Promise<WhoopOverviewReadModel> {
    const end = now.toISOString();
    const currentUtcDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ));
    const thirtyDayStartDate = new Date(currentUtcDate);
    thirtyDayStartDate.setUTCDate(thirtyDayStartDate.getUTCDate() - 29);
    const thirtyDayStart = thirtyDayStartDate.toISOString();
    const noCursor = { end, limit: 100, cursor: null } as const;
    const [currentCycles, cycles, recoveries, sleeps, workouts] = await Promise.all([
      this.listCycles(whoopUserId, { start: null, end, limit: 1, cursor: null }),
      this.listCycles(whoopUserId, { ...noCursor, start: thirtyDayStart }),
      this.listRecoveries(whoopUserId, { ...noCursor, start: thirtyDayStart }),
      this.listSleeps(whoopUserId, { ...noCursor, start: thirtyDayStart }),
      this.listWorkouts(whoopUserId, { start: null, end, limit: 5, cursor: null }),
    ]);
    const currentCycle = currentCycles.records[0] ?? null;
    const currentRecovery = currentCycle
      ? recoveries.records.find((record) => record.cycle_id === currentCycle.cycle_id) ?? null
      : recoveries.records[0] ?? null;
    const currentSleep = currentCycle && currentRecovery
      ? sleeps.records.find((record) =>
        record.cycle_id === currentCycle.cycle_id && record.sleep_id === currentRecovery.sleep_id
      ) ?? null
      : null;
    const recoveryByCycle = new Map<number, WhoopRecoveryReadModel>();
    for (const recovery of recoveries.records) {
      if (!recoveryByCycle.has(recovery.cycle_id)) recoveryByCycle.set(recovery.cycle_id, recovery);
    }
    const sleepByCycle = new Map<number, WhoopSleepReadModel>();
    for (const sleep of sleeps.records) {
      if (sleep.nap !== true && !sleepByCycle.has(sleep.cycle_id)) sleepByCycle.set(sleep.cycle_id, sleep);
    }
    const trends30 = cycles.records.slice().reverse().map((cycle) => ({
      date: new Date(cycle.start_at).toISOString().slice(0, 10),
      recovery_score: recoveryByCycle.get(cycle.cycle_id)?.score ?? null,
      strain: cycle.strain,
      sleep_performance_percentage:
        sleepByCycle.get(cycle.cycle_id)?.sleep_performance_percentage ?? null,
    }));
    const sevenDayStartDate = new Date(currentUtcDate);
    sevenDayStartDate.setUTCDate(sevenDayStartDate.getUTCDate() - 6);
    const sevenDayDate = sevenDayStartDate.toISOString().slice(0, 10);
    return {
      current_cycle: currentCycle,
      current_recovery: currentRecovery,
      current_sleep: currentSleep,
      recent_workouts: workouts.records,
      trends_7_days: trends30.filter((point) => point.date >= sevenDayDate),
      trends_30_days: trends30,
    };
  }
}
