ALTER TABLE shelf_items ADD COLUMN status TEXT;
ALTER TABLE shelf_items ADD COLUMN rating REAL;
ALTER TABLE shelf_items ADD COLUMN rating_scale INTEGER;
ALTER TABLE shelf_items ADD COLUMN started_at TEXT;
ALTER TABLE shelf_items ADD COLUMN completed_at TEXT;
ALTER TABLE shelf_items ADD COLUMN last_watched_at TEXT;
ALTER TABLE shelf_items ADD COLUMN progress_current REAL;
ALTER TABLE shelf_items ADD COLUMN progress_total REAL;
ALTER TABLE shelf_items ADD COLUMN progress_unit TEXT;
ALTER TABLE shelf_items ADD COLUMN favorite_rank INTEGER;
ALTER TABLE shelf_items ADD COLUMN showcase INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shelf_items ADD COLUMN metadata_json TEXT;

CREATE INDEX IF NOT EXISTS idx_shelf_items_status ON shelf_items (status);
CREATE INDEX IF NOT EXISTS idx_shelf_items_showcase ON shelf_items (showcase) WHERE showcase = 1;
CREATE INDEX IF NOT EXISTS idx_shelf_items_completed_at ON shelf_items (completed_at);
