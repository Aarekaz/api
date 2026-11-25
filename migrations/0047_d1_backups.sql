-- The monthly D1 backup to the private bucket (services/d1-backup.ts). A run
-- copies every table to backups/YYYY-MM-DD/<table>.ndjson.gz a little at a
-- time, one cron tick after another, so these rows are where it left off.
-- Additive only: three new tables.
--
--   backup_runs:   one row per run (id is the folder's date).
--   backup_tables: the tables a run copies, fixed when it starts, with how far
--                  each has got: the last rowid written, rows and bytes so far,
--                  and the multipart upload and its parts for a large one.
--   backup_carry:  compressed bytes waiting for the next part. R2 needs every
--                  part but the last to be the same size, so what's left over
--                  after a tick waits here (base64, in chunks under D1's row
--                  limit). `gen` lets new bytes be written before the old ones
--                  are let go.
CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                 -- running | done | failed
  trigger TEXT NOT NULL,                -- cron | manual
  prefix TEXT NOT NULL,                 -- backups/YYYY-MM-DD/
  started_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  ticks INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,  -- failed ticks in a row
  error TEXT,
  lease_until TEXT,                     -- a tick at work holds the run until then
  schema_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS backup_runs_started ON backup_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS backup_tables (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  sql TEXT,
  without_rowid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | writing | done
  last_rowid INTEGER,                     -- the offset for a WITHOUT ROWID table
  rows INTEGER NOT NULL DEFAULT 0,
  raw_bytes INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,       -- compressed bytes in R2 (parts uploaded, then the whole object)
  upload_id TEXT,
  parts_json TEXT NOT NULL DEFAULT '[]',
  carry_gen INTEGER NOT NULL DEFAULT 0,
  carry_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, name)
);

CREATE TABLE IF NOT EXISTS backup_carry (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  gen INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, name, gen, seq)
);
