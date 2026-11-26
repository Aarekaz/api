-- Journal reads (routes/journal.ts) filter and sort live journal entries by
-- when they happened, COALESCE(json_extract(frontmatter_json, '$.happened_at'),
-- created_at). This indexes that exact expression, with id and version, so the
-- list pages in index order and /stats reads days without opening a row. It
-- leads with kind (constant here) so the planner sees the kind equality in it
-- and prefers it to documents_kind_updated.
CREATE INDEX IF NOT EXISTS documents_journal_when
  ON documents(kind, COALESCE(json_extract(frontmatter_json, '$.happened_at'), created_at), id, version)
  WHERE kind = 'journal' AND deleted_at IS NULL;

-- Each journal entry's word count, as of the document version it was counted
-- at (services/journal-words.ts). Derived: a missing or older row is counted
-- from the body again, so it can be dropped or rebuilt at any time.
CREATE TABLE IF NOT EXISTS journal_words (
  document_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  words INTEGER NOT NULL
) WITHOUT ROWID;
