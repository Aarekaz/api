-- Highlights and notes on what you read (and later on your own pages).
-- Additive only: a new table; nothing existing changes.

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  text TEXT NOT NULL,
  -- A little of the text around the highlight, so it can be found again if
  -- the article's text shifts.
  prefix TEXT,
  suffix TEXT,
  note TEXT,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS highlights_document ON highlights (document_id, created_at);
CREATE INDEX IF NOT EXISTS highlights_updated ON highlights (updated_at DESC);
