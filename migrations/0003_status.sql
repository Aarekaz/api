CREATE TABLE IF NOT EXISTS status_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_status TEXT,
  activity_json TEXT,
  spotify_json TEXT,
  payload_json TEXT,
  created_at TEXT
);
