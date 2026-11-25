-- A version number per kind of data, bumped on every write to it, so a GET can
-- answer 304 Not Modified when nothing changed (ETag / If-None-Match).
-- Additive only: one new table.
--   places: visits, journeys, place names and saved places (every /v1/visits read).
CREATE TABLE IF NOT EXISTS data_versions (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
