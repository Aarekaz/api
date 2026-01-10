CREATE TABLE IF NOT EXISTS wakatime_days (
  date TEXT PRIMARY KEY,
  total_seconds REAL,
  total_minutes INTEGER,
  timezone TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS wakatime_languages (
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  total_seconds REAL,
  total_minutes INTEGER,
  percent REAL,
  PRIMARY KEY (date, name)
);

CREATE TABLE IF NOT EXISTS wakatime_projects (
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  total_seconds REAL,
  total_minutes INTEGER,
  percent REAL,
  PRIMARY KEY (date, name)
);

CREATE TABLE IF NOT EXISTS wakatime_editors (
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  total_seconds REAL,
  total_minutes INTEGER,
  percent REAL,
  PRIMARY KEY (date, name)
);

CREATE TABLE IF NOT EXISTS wakatime_hourly (
  date TEXT NOT NULL,
  hour INTEGER NOT NULL,
  seconds REAL,
  languages_json TEXT,
  PRIMARY KEY (date, hour)
);

CREATE TABLE IF NOT EXISTS wakatime_refresh_log (
  type TEXT PRIMARY KEY,
  last_run_at TEXT
);
