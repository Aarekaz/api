-- The local date a visit began (arrived_at) or a journey started (started_at),
-- where it happened: the row's own utc_offset, or America/New_York for a row
-- without one. Written at ingest (services/places.ts localDate), so reads can
-- go by date instead of shifting every row by an offset. Rows older than this
-- column are filled once by scripts/backfill-local-date.mjs. Additive only: two
-- nullable columns and their indexes; no read uses them yet.
ALTER TABLE visits ADD COLUMN local_date TEXT;
ALTER TABLE journeys ADD COLUMN local_date TEXT;
CREATE INDEX IF NOT EXISTS visits_local_date ON visits (local_date);
CREATE INDEX IF NOT EXISTS journeys_local_date ON journeys (local_date);
