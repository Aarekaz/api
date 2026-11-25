-- Corrections you make on a visit, from the app (Apple Maps' Remove, Wrong
-- location, Add Note). Additive only: two nullable columns and a view.
--   hidden_at: you said it wasn't a visit; it leaves the map, days and counts,
--              but the row stays (unhide by clearing it).
--   note:      a line about that visit, searchable.
-- A visit moved to the right place keeps its old spot in guess_latitude/
-- guess_longitude (0041). Every read goes through shown_visits.
ALTER TABLE visits ADD COLUMN hidden_at TEXT;
ALTER TABLE visits ADD COLUMN note TEXT;
CREATE VIEW IF NOT EXISTS shown_visits AS SELECT * FROM visits WHERE hidden_at IS NULL;
