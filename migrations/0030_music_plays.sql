-- Every song you play on Spotify, kept. Spotify only remembers the last 50,
-- so a job copies them here every half hour. Additive only: a new table.

CREATE TABLE IF NOT EXISTS music_plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  played_at TEXT NOT NULL,
  track_id TEXT NOT NULL,
  track TEXT NOT NULL,
  artists TEXT,
  album TEXT,
  image_url TEXT,
  duration_ms INTEGER,
  url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (played_at, track_id)
);

CREATE INDEX IF NOT EXISTS music_plays_played ON music_plays (played_at DESC);
