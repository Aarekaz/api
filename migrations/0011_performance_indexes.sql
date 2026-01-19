-- Performance indexes for common query patterns
-- Fixed: 2026-01-19 (Corrected table/column names to match actual schema)

-- ===========================================================================
-- Apple Health Tables
-- ===========================================================================

-- Daily health data - frequently queried by date range
CREATE INDEX IF NOT EXISTS idx_health_daily_date_desc
  ON apple_health_daily(date DESC);

-- Heart rate samples - queried by time range
CREATE INDEX IF NOT EXISTS idx_health_heart_rate_recorded_at_desc
  ON apple_health_heart_rate(recorded_at DESC);

-- Sleep sessions - queried by start time
CREATE INDEX IF NOT EXISTS idx_health_sleep_start_at_desc
  ON apple_health_sleep_sessions(start_at DESC);

-- Workouts - queried by start time and workout type
CREATE INDEX IF NOT EXISTS idx_health_workouts_start_at_desc
  ON apple_health_workouts(start_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_workouts_type
  ON apple_health_workouts(workout_type);

-- ===========================================================================
-- External Integration Tables
-- ===========================================================================

-- WakaTime daily summaries - queried by date range
CREATE INDEX IF NOT EXISTS idx_wakatime_days_date_desc
  ON wakatime_days(date DESC);

-- WakaTime hourly data - queried by date
CREATE INDEX IF NOT EXISTS idx_wakatime_hourly_date_desc
  ON wakatime_hourly(date DESC);

-- GitHub daily contributions - queried by date range
CREATE INDEX IF NOT EXISTS idx_github_daily_date_desc
  ON github_daily(date DESC);

-- ===========================================================================
-- Content Tables
-- ===========================================================================

-- Projects - sorted by creation date
CREATE INDEX IF NOT EXISTS idx_projects_created_at_desc
  ON projects(created_at DESC);

-- Posts - queried by published date and pinned status
CREATE INDEX IF NOT EXISTS idx_posts_published_at_desc
  ON posts(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_posts_pinned_published
  ON posts(pinned, published_at DESC);

-- ===========================================================================
-- Location Table
-- ===========================================================================

-- Location history - queried by recorded time
CREATE INDEX IF NOT EXISTS idx_location_history_recorded_at_desc
  ON location_history(recorded_at DESC);

-- ===========================================================================
-- Custom Workout Tables
-- ===========================================================================

-- Workout sessions - queried by started_at
CREATE INDEX IF NOT EXISTS idx_custom_sessions_started_at_desc
  ON custom_workout_sessions(started_at DESC);

-- Workout sets - queried by session and exercise
CREATE INDEX IF NOT EXISTS idx_custom_sets_session
  ON custom_workout_sets(session_id);

CREATE INDEX IF NOT EXISTS idx_custom_sets_exercise
  ON custom_workout_sets(exercise_id);

-- ===========================================================================
-- Log Tables
-- ===========================================================================

-- Daily logs - queried by log_date
CREATE INDEX IF NOT EXISTS idx_daily_logs_date_desc
  ON daily_logs(log_date DESC);

-- ===========================================================================
-- General Performance
-- ===========================================================================

-- Created_at/occurred_at indexes for common ORDER BY patterns
CREATE INDEX IF NOT EXISTS idx_notes_created_at_desc
  ON notes(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_occurred_at_desc
  ON events(occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_photos_created_at_desc
  ON photos(created_at DESC);

