-- Read later, synced: where you are in each article and your note on it.
-- Inbox / Archive is the link's existing `links.read_at` (archived when set),
-- so the state can't drift from what Wrapped and older clients already read.
-- Progress is last-write-wins by `progress_updated_at` (the moment you read,
-- sent by the device), so the phone and the Mac pick up where the other left.
-- Additive only: a new table; no existing table or row changes.

CREATE TABLE IF NOT EXISTS link_reading (
  document_id TEXT PRIMARY KEY,
  -- 0…1 through the article.
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  -- Where you were, as the reader describes it ("b12:0.34" = block 12, a third
  -- of the way in; "page:4" in a PDF), so it restores at any window width.
  progress_anchor TEXT,
  progress_updated_at TEXT,
  -- Which device wrote it last ("iPhone", "Mac").
  progress_device TEXT,
  -- The first time the article was opened.
  opened_at TEXT,
  -- Your note on the whole article.
  note TEXT,
  note_updated_at TEXT
);

CREATE INDEX IF NOT EXISTS links_read_at ON links (read_at);
