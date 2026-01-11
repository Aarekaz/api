-- Location tracking from iOS Shortcuts
-- Stores GPS coordinates with timestamps

CREATE TABLE IF NOT EXISTS location_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  altitude REAL,                    -- meters above sea level
  accuracy REAL,                    -- horizontal accuracy in meters
  speed REAL,                       -- meters per second
  heading REAL,                     -- degrees (0-360)
  recorded_at TEXT NOT NULL,        -- ISO 8601 timestamp
  
  -- Reverse geocoding (optional, can be added later)
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  postal_code TEXT,
  
  -- Context
  label TEXT,                       -- e.g., "home", "work", "gym", "travel"
  notes TEXT,
  source TEXT,                      -- e.g., "ios_shortcuts", "manual"
  
  created_at TEXT NOT NULL
);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_location_recorded_at ON location_history(recorded_at);

-- Index for label filtering
CREATE INDEX IF NOT EXISTS idx_location_label ON location_history(label);

-- Index for date-based queries (extracting date from timestamp)
CREATE INDEX IF NOT EXISTS idx_location_date ON location_history(date(recorded_at));
