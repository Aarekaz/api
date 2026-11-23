-- How you got between places: one row per movement (walking, driving, a
-- flight), or a stretch of raw route points (mode 'path', points_json holds
-- [[lat, lng, minutes from start], ...]). Additive only: a new table.
-- source_key makes imports safe to run again.

CREATE TABLE IF NOT EXISTS journeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  start_lat REAL,
  start_lng REAL,
  end_lat REAL,
  end_lng REAL,
  distance_m REAL,
  mode TEXT,
  points_json TEXT,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS journeys_started ON journeys (started_at);
