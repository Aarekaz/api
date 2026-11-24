-- Places you define yourself: a centre, a radius, a name and kind, and the
-- months it applies (a home from 2017 to 2024). Visits inside the circle in
-- those months count as this place. Additive only.
CREATE TABLE IF NOT EXISTS saved_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 150,
  address TEXT,
  starts_on TEXT,
  ends_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
