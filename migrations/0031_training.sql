-- A simple training plan (WHOOP does the tracking): routines with their
-- exercises and targets, which weekdays they fall on, and a log of the sets
-- you ticked off. Additive only: new tables.

CREATE TABLE IF NOT EXISTS training_routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  weekdays TEXT NOT NULL DEFAULT '',          -- "1,4" = Monday, Thursday (ISO: 1 = Monday)
  exercises_json TEXT NOT NULL DEFAULT '[]',  -- [{name, sets, reps, weight, unit, rest}]
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS training_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id TEXT,
  day TEXT NOT NULL,                          -- local date, YYYY-MM-DD
  exercise TEXT NOT NULL,
  set_number INTEGER NOT NULL,
  reps INTEGER,
  weight REAL,
  unit TEXT,
  done_at TEXT NOT NULL,
  UNIQUE (day, exercise, set_number)
);

CREATE INDEX IF NOT EXISTS training_sets_exercise ON training_sets (exercise, day DESC);
