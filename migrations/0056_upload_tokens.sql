-- Presigned upload tokens are single use: one row per token spent, keyed by
-- the R2 key it was signed for (a fresh UUID per presign, so one key is one
-- token). A second PUT with the same token finds the row and is refused.
-- Rows are only needed until the token would have expired anyway; each claim
-- deletes the expired ones. Additive only: one new table and its index.
--   key         the R2 key in the token (photos/… or blog/…)
--   expires_at  the token's expiry, milliseconds since the epoch
--   used_at     server time of the PUT that spent it
CREATE TABLE IF NOT EXISTS upload_tokens (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS upload_tokens_expires_at ON upload_tokens (expires_at);
