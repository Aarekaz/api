ALTER TABLE posts ADD COLUMN created_at TEXT;

ALTER TABLE uses_items ADD COLUMN updated_at TEXT;

ALTER TABLE shelf_items ADD COLUMN created_at TEXT;
ALTER TABLE shelf_items ADD COLUMN updated_at TEXT;

ALTER TABLE experience ADD COLUMN created_at TEXT;
ALTER TABLE experience ADD COLUMN updated_at TEXT;

ALTER TABLE education ADD COLUMN created_at TEXT;
ALTER TABLE education ADD COLUMN updated_at TEXT;

ALTER TABLE skills ADD COLUMN created_at TEXT;

ALTER TABLE photos ADD COLUMN updated_at TEXT;

ALTER TABLE notes ADD COLUMN updated_at TEXT;

ALTER TABLE events ADD COLUMN created_at TEXT;
ALTER TABLE events ADD COLUMN updated_at TEXT;

ALTER TABLE location_history ADD COLUMN updated_at TEXT;

ALTER TABLE apple_health_workouts ADD COLUMN updated_at TEXT;
