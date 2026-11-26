-- WHOOP collection reads (services/whoop/read-repository.ts listRows) filter
-- and sort by the ISO text of each row's instant. These index that exact
-- expression after the user, with the key as the tie-break, so a page is a
-- seek in index order instead of a scan and sort of every row. Partial on
-- live rows, which are the only ones read.
CREATE INDEX IF NOT EXISTS idx_whoop_cycles_read
  ON whoop_cycles(whoop_user_id, strftime('%Y-%m-%dT%H:%M:%fZ', start_at), cycle_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_whoop_recoveries_read
  ON whoop_recoveries(whoop_user_id, strftime('%Y-%m-%dT%H:%M:%fZ', upstream_created_at), sleep_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_whoop_sleeps_read
  ON whoop_sleeps(whoop_user_id, strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(start_at, upstream_created_at)), sleep_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_whoop_workouts_read
  ON whoop_workouts(whoop_user_id, strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(start_at, upstream_created_at)), workout_id)
  WHERE deleted_at IS NULL;
