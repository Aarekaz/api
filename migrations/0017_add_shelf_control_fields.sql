ALTER TABLE shelf_items ADD COLUMN shelf_group TEXT;
ALTER TABLE shelf_items ADD COLUMN display_order INTEGER;
ALTER TABLE shelf_items ADD COLUMN cover_override_url TEXT;
ALTER TABLE shelf_items ADD COLUMN spine_image_url TEXT;
ALTER TABLE shelf_items ADD COLUMN goodreads_id TEXT;
ALTER TABLE shelf_items ADD COLUMN isbn TEXT;
ALTER TABLE shelf_items ADD COLUMN apple_books_id TEXT;

CREATE INDEX IF NOT EXISTS idx_shelf_items_group ON shelf_items (shelf_group);
CREATE INDEX IF NOT EXISTS idx_shelf_items_display_order ON shelf_items (display_order);
CREATE INDEX IF NOT EXISTS idx_shelf_items_goodreads_id ON shelf_items (goodreads_id);
CREATE INDEX IF NOT EXISTS idx_shelf_items_isbn ON shelf_items (isbn);
