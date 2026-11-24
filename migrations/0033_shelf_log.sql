-- The Library's diary: one row each time you start, move along, finish,
-- rewatch or reread something on the shelf (books, movies, shows, anime).
-- shelf_items keeps the current state (status, progress, rating, dates);
-- shelf_log keeps the history, like a Letterboxd diary.
-- Additive only: a new table and its indexes. No existing table changes.

CREATE TABLE IF NOT EXISTS shelf_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  -- started | progress | finished | paused | dropped | want | rated | note
  kind TEXT NOT NULL,
  -- When it happened (a date or a full timestamp), not when it was saved.
  logged_at TEXT NOT NULL,
  status TEXT,
  progress_current REAL,
  progress_total REAL,
  progress_unit TEXT,
  season INTEGER,
  episode INTEGER,
  rating REAL,
  note TEXT,
  rewatch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_shelf_log_item ON shelf_log (item_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_shelf_log_logged_at ON shelf_log (logged_at);
