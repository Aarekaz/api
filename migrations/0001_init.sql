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

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT,
  tags_json TEXT,
  published_at TEXT,
  pinned INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS uses_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  note TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS shelf_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT,
  quote TEXT,
  author TEXT,
  source TEXT,
  url TEXT,
  note TEXT,
  image_url TEXT,
  drawer TEXT,
  tags_json TEXT,
  date_added TEXT
);

CREATE TABLE IF NOT EXISTS experience (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  location TEXT,
  start_date TEXT,
  end_date TEXT,
  employment_type TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS education (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  institution TEXT NOT NULL,
  degree TEXT,
  field TEXT,
  start_date TEXT,
  end_date TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  items_json TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  description TEXT,
  url TEXT NOT NULL,
  thumb_url TEXT,
  width INTEGER,
  height INTEGER,
  shot_at TEXT,
  camera TEXT,
  lens TEXT,
  settings TEXT,
  location TEXT,
  tags_json TEXT,
  created_at TEXT
);
