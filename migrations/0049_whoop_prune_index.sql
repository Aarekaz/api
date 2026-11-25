-- WHOOP retention (review 2026-11-25). Additive only.
-- The checkpoint prune keeps the newest finished checkpoint of each resource and
-- mode and asks, for every older one, whether a newer one exists. No index had
-- created_at right after those columns, so each question walked the whole
-- resource (~8.6k rows) from its oldest checkpoint: ~48 s of CPU for 51k rows,
-- past D1's limit, which reset the database on every cron tick. With this index
-- the question is one seek.
CREATE INDEX IF NOT EXISTS idx_whoop_sync_checkpoints_latest
  ON whoop_sync_checkpoints(whoop_user_id, connection_id, resource, mode, target_id, created_at, sync_run_id);
