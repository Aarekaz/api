-- Places you've been: one row per visit (arrive, leave). Additive only: a new
-- table. Sources: "visit" (the phone, live), "photos" (photo locations),
-- "google-timeline" (an export), "workout". source_key makes imports safe to
-- run again.

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  arrived_at TEXT NOT NULL,
  departed_at TEXT,
  place TEXT,
  address TEXT,
  city TEXT,
  country TEXT,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS visits_arrived ON visits (arrived_at DESC);
