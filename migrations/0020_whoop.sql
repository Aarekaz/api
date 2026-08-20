-- WHOOP Developer API v2 source records and synchronization state.
-- Existing apple_health_* history remains untouched.

CREATE TABLE IF NOT EXISTS whoop_connections (
  whoop_user_id INTEGER PRIMARY KEY,
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connecting', 'backfilling', 'active', 'needs_reauth', 'disconnected', 'error')),
  access_token_ciphertext TEXT,
  access_token_nonce TEXT,
  access_token_expires_at TEXT,
  refresh_token_ciphertext TEXT,
  refresh_token_nonce TEXT,
  granted_scopes TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  initial_backfill_pending INTEGER NOT NULL DEFAULT 0,
  refresh_lease_id TEXT,
  refresh_lease_expires_at TEXT,
  refresh_dispatched_at TEXT,
  connected_at TEXT,
  refreshed_at TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  disconnected_at TEXT,
  last_error TEXT,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whoop_oauth_states (
  state_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS whoop_profiles (
  whoop_user_id INTEGER PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  upstream_created_at TEXT,
  upstream_updated_at TEXT,
  deleted_at TEXT,
  synced_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whoop_profiles_user_updated ON whoop_profiles(whoop_user_id, upstream_updated_at);
CREATE INDEX IF NOT EXISTS idx_whoop_profiles_deleted ON whoop_profiles(deleted_at);

CREATE TABLE IF NOT EXISTS whoop_body_measurements (
  whoop_user_id INTEGER PRIMARY KEY,
  height_meter REAL,
  weight_kilogram REAL,
  max_heart_rate INTEGER,
  upstream_created_at TEXT,
  upstream_updated_at TEXT,
  deleted_at TEXT,
  synced_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whoop_body_measurements_user_updated ON whoop_body_measurements(whoop_user_id, upstream_updated_at);
CREATE INDEX IF NOT EXISTS idx_whoop_body_measurements_deleted ON whoop_body_measurements(deleted_at);

CREATE TABLE IF NOT EXISTS whoop_cycles (
  cycle_id INTEGER PRIMARY KEY,
  whoop_user_id INTEGER NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  timezone_offset TEXT,
  score_state TEXT,
  strain REAL,
  kilojoules REAL,
  average_heart_rate REAL,
  max_heart_rate REAL,
  upstream_created_at TEXT NOT NULL,
  upstream_updated_at TEXT NOT NULL,
  deleted_at TEXT,
  synced_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whoop_cycles_user_start ON whoop_cycles(whoop_user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_whoop_cycles_user_end ON whoop_cycles(whoop_user_id, end_at);
CREATE INDEX IF NOT EXISTS idx_whoop_cycles_deleted ON whoop_cycles(deleted_at);

CREATE TABLE IF NOT EXISTS whoop_recoveries (
  sleep_id TEXT PRIMARY KEY,
  cycle_id INTEGER NOT NULL,
  whoop_user_id INTEGER NOT NULL,
  score_state TEXT,
  user_calibrating INTEGER,
  recovery_score REAL,
  resting_heart_rate REAL,
  hrv_rmssd_milliseconds REAL,
  spo2_percentage REAL,
  skin_temperature_celsius REAL,
  upstream_created_at TEXT NOT NULL,
  upstream_updated_at TEXT NOT NULL,
  deleted_at TEXT,
  synced_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whoop_recoveries_user_updated ON whoop_recoveries(whoop_user_id, upstream_updated_at);
CREATE INDEX IF NOT EXISTS idx_whoop_recoveries_deleted ON whoop_recoveries(deleted_at);

CREATE TABLE IF NOT EXISTS whoop_sleeps (
  sleep_id TEXT PRIMARY KEY,
  cycle_id INTEGER NOT NULL,
  whoop_user_id INTEGER NOT NULL,
  start_at TEXT,
  end_at TEXT,
  timezone_offset TEXT,
  nap INTEGER,
  score_state TEXT,
  stage_awake_milliseconds INTEGER,
  stage_light_milliseconds INTEGER,
  stage_slow_wave_milliseconds INTEGER,
  stage_rem_milliseconds INTEGER,
  sleep_needed_milliseconds INTEGER,
  sleep_debt_milliseconds INTEGER,
  sleep_efficiency_percentage REAL,
  sleep_consistency_percentage REAL,
  sleep_performance_percentage REAL,
  respiratory_rate REAL,
  upstream_created_at TEXT NOT NULL,
  upstream_updated_at TEXT NOT NULL,
  deleted_at TEXT,
  synced_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whoop_sleeps_user_start ON whoop_sleeps(whoop_user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_whoop_sleeps_user_end ON whoop_sleeps(whoop_user_id, end_at);
CREATE INDEX IF NOT EXISTS idx_whoop_sleeps_deleted ON whoop_sleeps(deleted_at);

CREATE TABLE IF NOT EXISTS whoop_workouts (
  workout_id TEXT PRIMARY KEY,
  whoop_user_id INTEGER NOT NULL,
  start_at TEXT,
  end_at TEXT,
  timezone_offset TEXT,
  sport_id INTEGER,
  sport_name TEXT,
  score_state TEXT,
  strain REAL,
  average_heart_rate REAL,
  max_heart_rate REAL,
  kilojoules REAL,
  percent_recorded REAL,
  distance_meter REAL,
  elevation_gain_meter REAL,
  zone_zero_milliseconds INTEGER,
  zone_one_milliseconds INTEGER,
  zone_two_milliseconds INTEGER,
  zone_three_milliseconds INTEGER,
  zone_four_milliseconds INTEGER,
  zone_five_milliseconds INTEGER,
  upstream_created_at TEXT NOT NULL,
  upstream_updated_at TEXT NOT NULL,
  deleted_at TEXT,
  synced_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whoop_workouts_user_start ON whoop_workouts(whoop_user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_whoop_workouts_user_end ON whoop_workouts(whoop_user_id, end_at);
CREATE INDEX IF NOT EXISTS idx_whoop_workouts_deleted ON whoop_workouts(deleted_at);

CREATE TABLE IF NOT EXISTS whoop_webhook_events (
  trace_id TEXT PRIMARY KEY,
  whoop_user_id INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('workout.updated', 'workout.deleted', 'sleep.updated', 'sleep.deleted', 'recovery.updated', 'recovery.deleted')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_whoop_webhook_events_user_received ON whoop_webhook_events(whoop_user_id, received_at);

CREATE TABLE IF NOT EXISTS whoop_sync_checkpoints (
  whoop_user_id INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  mode TEXT NOT NULL,
  window_start TEXT,
  window_end TEXT,
  next_token TEXT,
  status TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (whoop_user_id, resource)
);

CREATE TABLE IF NOT EXISTS whoop_sync_runs (
  run_id TEXT PRIMARY KEY,
  whoop_user_id INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  succeeded_at TEXT,
  failed_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_whoop_sync_runs_user_started ON whoop_sync_runs(whoop_user_id, started_at);
