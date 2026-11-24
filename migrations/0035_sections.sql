-- Writing's folders as a real tree. A folder is named by its path
-- ("Library/Agent Skills"), the same string documents.folder already holds, so
-- every page, backup and client keeps working as it is. `parent` is the
-- parent folder's path ('' at the top). A row keeps a folder alive with no
-- pages in it; folders that pages already use are added on first listing.
-- Additive only: no existing table or row changes.

CREATE TABLE IF NOT EXISTS sections (
  path TEXT PRIMARY KEY,
  parent TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  sort_order INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS sections_parent ON sections (parent);
CREATE INDEX IF NOT EXISTS documents_folder ON documents (folder);
