-- Add a `published` boolean to every user-facing content table so each
-- item can be individually hidden from the public website without being
-- deleted. Defaults to 1 (published) so existing content stays visible.
--
-- Posts already have their own `published` + `published_at` columns, so
-- they're skipped here.

ALTER TABLE projects    ADD COLUMN published INTEGER NOT NULL DEFAULT 1;
ALTER TABLE photos      ADD COLUMN published INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shelf_items ADD COLUMN published INTEGER NOT NULL DEFAULT 1;
ALTER TABLE uses_items  ADD COLUMN published INTEGER NOT NULL DEFAULT 1;
ALTER TABLE skills      ADD COLUMN published INTEGER NOT NULL DEFAULT 1;
ALTER TABLE experience  ADD COLUMN published INTEGER NOT NULL DEFAULT 1;
ALTER TABLE education   ADD COLUMN published INTEGER NOT NULL DEFAULT 1;

-- Partial indexes for the hot path: public GETs filter WHERE published = 1
CREATE INDEX IF NOT EXISTS idx_projects_published    ON projects    (published) WHERE published = 1;
CREATE INDEX IF NOT EXISTS idx_photos_published      ON photos      (published) WHERE published = 1;
CREATE INDEX IF NOT EXISTS idx_shelf_items_published ON shelf_items (published) WHERE published = 1;
CREATE INDEX IF NOT EXISTS idx_uses_items_published  ON uses_items  (published) WHERE published = 1;
CREATE INDEX IF NOT EXISTS idx_skills_published      ON skills      (published) WHERE published = 1;
CREATE INDEX IF NOT EXISTS idx_experience_published  ON experience  (published) WHERE published = 1;
CREATE INDEX IF NOT EXISTS idx_education_published   ON education   (published) WHERE published = 1;
