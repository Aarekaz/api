CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY,
  name TEXT,
  bio TEXT,
  handles_json TEXT,
  contact_json TEXT,
  timezone TEXT,
  avatar_url TEXT,
  location TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS now_state (
  id INTEGER PRIMARY KEY,
  focus TEXT,
  status TEXT,
  availability TEXT,
  mood TEXT,
  current_song TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  links_json TEXT,
  tags_json TEXT,
  status TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  body TEXT,
  tags_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  payload_json TEXT,
  occurred_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  public_fields_json TEXT,
  theme TEXT,
  flags_json TEXT,
  updated_at TEXT
);
