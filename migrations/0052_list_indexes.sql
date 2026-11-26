-- Indexes for list reads whose default order no index served, so each page
-- sorted the whole table. Additive only: indexes, no data change.
-- docs/audit-2026-11.md section 8.5; checked by __tests__/schemas/list-indexes.test.ts.
--   GET /v1/shelf               WHERE published = 1 ORDER BY date_added DESC (the website's shelf)
--   GET /v1/photos              WHERE published = 1 ORDER BY shot_at DESC, created_at DESC (the website's photography)
--   GET /v1/highlights          ORDER BY created_at DESC, id DESC (no document filter)
--   GET /v1/visits/flights      WHERE mode = 'flying' ORDER BY started_at (a seek, not a scan of every journey)
--   GET /v1/links               ORDER BY created_at DESC, id DESC over documents
CREATE INDEX IF NOT EXISTS idx_shelf_items_published_date_added ON shelf_items (published, date_added DESC);
CREATE INDEX IF NOT EXISTS idx_photos_published_shot_at ON photos (published, shot_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS highlights_created ON highlights (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS journeys_mode_started ON journeys (mode, started_at);
CREATE INDEX IF NOT EXISTS documents_created ON documents (created_at DESC, id DESC);
