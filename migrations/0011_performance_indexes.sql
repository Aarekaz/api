-- Performance indexes for common query patterns
-- Applied: 2026-01-19

-- ===========================================================================
-- Apple Health Tables
-- ===========================================================================

-- Daily health data - frequently queried by date range
CREATE INDEX IF NOT EXISTS idx_health_daily_date 
  ON apple_health_daily(date DESC);

-- Heart rate samples - queried by time range, often with high volume
CREATE INDEX IF NOT EXISTS idx_health_heart_rate_recorded_at 
  ON apple_health_heart_rate(recorded_at DESC);

-- Sleep sessions - queried by start time
CREATE INDEX IF NOT EXISTS idx_health_sleep_start_at 
  ON apple_health_sleep_sessions(start_at DESC);

-- Workouts - queried by start time and optionally by type
CREATE INDEX IF NOT EXISTS idx_health_workouts_start_at 
  ON apple_health_workouts(start_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_workouts_type 
  ON apple_health_workouts(workout_type);

-- ===========================================================================
-- External Integration Tables
-- ===========================================================================

-- WakaTime daily summaries - queried by date range
CREATE INDEX IF NOT EXISTS idx_wakatime_daily_date 
  ON wakatime_daily(date DESC);

-- WakaTime hourly data - queried by timestamp
CREATE INDEX IF NOT EXISTS idx_wakatime_hourly_timestamp 
  ON wakatime_hourly(timestamp DESC);

-- GitHub contributions - queried by date range
CREATE INDEX IF NOT EXISTS idx_github_contributions_date 
  ON github_contributions(date DESC);

-- ===========================================================================
-- Content Tables
-- ===========================================================================

-- Projects - queried by featured status and sort order
CREATE INDEX IF NOT EXISTS idx_projects_featured 
  ON projects(featured, sort_order);

-- Posts - queried by published date and pinned status
CREATE INDEX IF NOT EXISTS idx_posts_published_at 
  ON posts(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_posts_pinned 
  ON posts(pinned, published_at DESC);

-- ===========================================================================
-- Location Tables
-- ===========================================================================

-- Location history - queried by recorded time
CREATE INDEX IF NOT EXISTS idx_location_recorded_at 
  ON location(recorded_at DESC);

-- ===========================================================================
-- Custom Workout Tables
-- ===========================================================================

-- Workout sessions - queried by date
CREATE INDEX IF NOT EXISTS idx_custom_sessions_date 
  ON custom_workout_sessions(session_date DESC);

-- Workout sets - queried by session and exercise
CREATE INDEX IF NOT EXISTS idx_custom_sets_session 
  ON custom_workout_sets(session_id);

CREATE INDEX IF NOT EXISTS idx_custom_sets_exercise 
  ON custom_workout_sets(exercise_id);

-- ===========================================================================
-- Log Tables
-- ===========================================================================

-- Daily logs - queried by date
CREATE INDEX IF NOT EXISTS idx_logs_date 
  ON logs(date DESC);

-- ===========================================================================
-- General Performance
-- ===========================================================================

-- Created_at indexes for common "ORDER BY created_at DESC" patterns
CREATE INDEX IF NOT EXISTS idx_projects_created_at 
  ON projects(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_created_at 
  ON notes(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_created_at 
  ON events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_photos_created_at 
  ON photos(created_at DESC);
