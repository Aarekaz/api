-- Apple Health data from iOS Shortcuts
-- Stores daily health metrics from Apple Watch Series 8

CREATE TABLE IF NOT EXISTS apple_health_daily (
  date TEXT PRIMARY KEY,
  -- Heart & Cardiovascular
  resting_heart_rate REAL,
  heart_rate_avg REAL,
  heart_rate_min REAL,
  heart_rate_max REAL,
  hrv_avg REAL,                    -- Heart Rate Variability (ms)
  vo2_max REAL,                    -- VO2 Max (mL/kg/min)
  blood_oxygen_avg REAL,           -- SpO2 (%)
  blood_oxygen_min REAL,

  -- Body Measurements
  weight REAL,                     -- kg
  body_fat_percentage REAL,
  body_mass_index REAL,
  wrist_temperature REAL,          -- Deviation from baseline (°C)

  -- Activity
  steps INTEGER,
  active_energy REAL,              -- kcal
  resting_energy REAL,             -- kcal
  exercise_minutes INTEGER,
  stand_hours INTEGER,
  flights_climbed INTEGER,
  distance_walking_running REAL,   -- km

  -- Sleep (from previous night)
  sleep_duration_minutes INTEGER,
  sleep_deep_minutes INTEGER,
  sleep_core_minutes INTEGER,
  sleep_rem_minutes INTEGER,
  sleep_awake_minutes INTEGER,
  respiratory_rate_avg REAL,       -- breaths/min during sleep

  -- Mindfulness & Stress
  mindful_minutes INTEGER,

  -- Blood Pressure (manual entry)
  blood_pressure_systolic INTEGER,
  blood_pressure_diastolic INTEGER,

  -- Nutrition & Hydration
  water_intake_ml INTEGER,
  caffeine_mg INTEGER,

  -- Additional metadata
  source TEXT,                     -- e.g., "apple_watch", "iphone", "manual"
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- Index for date range queries
CREATE INDEX IF NOT EXISTS idx_apple_health_daily_date ON apple_health_daily(date);

-- Detailed heart rate samples (for more granular data if needed)
CREATE TABLE IF NOT EXISTS apple_health_heart_rate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  heart_rate REAL NOT NULL,
  context TEXT,                    -- e.g., "rest", "workout", "walking"
  source TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_apple_health_heart_rate_recorded ON apple_health_heart_rate(recorded_at);

-- Sleep sessions for detailed sleep tracking
CREATE TABLE IF NOT EXISTS apple_health_sleep_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  duration_minutes INTEGER,
  deep_minutes INTEGER,
  core_minutes INTEGER,
  rem_minutes INTEGER,
  awake_minutes INTEGER,
  sleep_quality_score REAL,        -- Calculated or from app
  respiratory_rate_avg REAL,
  heart_rate_avg REAL,
  hrv_avg REAL,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_apple_health_sleep_start ON apple_health_sleep_sessions(start_at);

-- Workouts
CREATE TABLE IF NOT EXISTS apple_health_workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_type TEXT NOT NULL,       -- e.g., "running", "cycling", "strength"
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  duration_minutes INTEGER,
  active_energy REAL,               -- kcal
  heart_rate_avg REAL,
  heart_rate_max REAL,
  distance REAL,                    -- km
  elevation_gain REAL,              -- meters
  source TEXT,
  notes TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_apple_health_workouts_start ON apple_health_workouts(start_at);
