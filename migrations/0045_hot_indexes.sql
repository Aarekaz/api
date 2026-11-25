-- Indexes for the hottest reads (review 2026-11-25). Additive only.
-- WHOOP's per-run rollup walked every checkpoint row (~500k reads a run, ~840M a day).
CREATE INDEX IF NOT EXISTS idx_whoop_sync_checkpoints_run ON whoop_sync_checkpoints(sync_run_id, mode, status);
-- Places look visits up by their ~110 m grid key, the same expression the routes use.
CREATE INDEX IF NOT EXISTS idx_visits_place ON visits(printf('%.3f,%.3f', latitude, longitude), arrived_at DESC);
-- The sources summary on every GET /v1/visits.
CREATE INDEX IF NOT EXISTS idx_visits_source ON visits(source, arrived_at);
