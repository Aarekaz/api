-- A day you chose to do something other than the plan (another workout, or rest).
-- One row per day; deleting it puts the day back on the plan. Additive only.
CREATE TABLE IF NOT EXISTS training_picks (
  day TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
