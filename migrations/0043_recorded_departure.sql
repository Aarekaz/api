-- Google Timeline leaves a visit open until it records again, so a stay can run
-- for days (work from Friday evening to Wednesday). When a stay is ended earlier
-- (at the first sign of you elsewhere, or at midnight for a place that isn't a
-- home), departed_at holds that end and Google's own end is kept here. Additive.
ALTER TABLE visits ADD COLUMN recorded_departed_at TEXT;
