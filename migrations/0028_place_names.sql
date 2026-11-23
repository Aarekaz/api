-- Names for places, keyed by the ~110 m grid cell the map groups visits by
-- ("38.898,-77.037"). Looked up once on a device, shared by every device.
-- Additive only: a new table. Visit rows are never rewritten.

CREATE TABLE IF NOT EXISTS place_names (
  key TEXT PRIMARY KEY,
  name TEXT,
  city TEXT,
  country TEXT,
  updated_at TEXT NOT NULL
);
