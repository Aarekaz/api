-- Everything the OS writes and keeps: notes, journal, writing, links, quotes.
-- Cloudflare is the source of truth; the GitHub vault is a nightly backup.
-- Additive only: no existing table is changed.

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'journal', 'writing', 'link', 'quote')),
  folder TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL DEFAULT '',
  frontmatter_json TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('locked', 'private', 'agents', 'public')),
  status TEXT CHECK (status IN ('draft', 'published')),
  post_id INTEGER,
  source TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS documents_kind_updated ON documents (kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS documents_updated ON documents (updated_at DESC);
CREATE INDEX IF NOT EXISTS documents_post ON documents (post_id);

CREATE TABLE IF NOT EXISTS document_versions (
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  frontmatter_json TEXT,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (document_id, version)
);

-- Full-text search over titles and bodies, kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, body, content='documents', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_delete AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts (documents_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_update AFTER UPDATE OF title, body ON documents BEGIN
  INSERT INTO documents_fts (documents_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO documents_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Read later. The article text, once fetched, is archived in R2.
CREATE TABLE IF NOT EXISTS links (
  document_id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  site TEXT,
  excerpt TEXT,
  reading_minutes INTEGER,
  archived_r2_key TEXT,
  read_at TEXT,
  fetched_at TEXT,
  fetch_error TEXT
);

-- Bookkeeping for background jobs (nightly backup and friends).
CREATE TABLE IF NOT EXISTS job_runs (
  job TEXT PRIMARY KEY,
  last_started_at TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  cursor TEXT
);
