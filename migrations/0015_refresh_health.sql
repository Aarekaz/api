CREATE TABLE IF NOT EXISTS refresh_health (
  name TEXT PRIMARY KEY,
  last_started_at TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
