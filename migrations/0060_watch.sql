-- Films and shows, tracked properly: TMDB's details kept beside the shelf, and
-- one row for every viewing (each episode, each film, each rewatch) with the
-- time it happened. shelf_items stays the title on your shelf (what the
-- website reads, unchanged); shelf_log stays the diary.
-- Additive only: four new tables and their indexes. No existing table changes
-- (shelf_items is read with SELECT *, so its links to TMDB live in their own table).

-- Which TMDB title a shelf item is. Filled from the item's tmdb_id / tmdb_media_type tags below.
CREATE TABLE IF NOT EXISTS media_links (
  item_id INTEGER PRIMARY KEY,
  -- movie | tv
  media_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_links_tmdb ON media_links (media_type, tmdb_id);

-- TMDB's details for a title, refreshed within six months (TMDB's terms) and
-- weekly for shows still airing. Nothing here is the owner's: it can be emptied
-- and fetched again at any time.
CREATE TABLE IF NOT EXISTS media_titles (
  media_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  original_title TEXT,
  year TEXT,
  release_date TEXT,
  -- Minutes: a film's length, a show's usual episode.
  runtime INTEGER,
  genres_json TEXT,
  overview TEXT,
  poster_path TEXT,
  backdrop_path TEXT,
  -- TMDB's: Released, Ended, Returning Series, Canceled, In Production, ...
  status TEXT,
  -- Regular seasons in order: [{ "season_number", "episode_count", "name", "air_date" }]
  seasons_json TEXT,
  next_episode_json TEXT,
  last_air_date TEXT,
  imdb_id TEXT,
  tvdb_id INTEGER,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (media_type, tmdb_id)
);
CREATE INDEX IF NOT EXISTS idx_media_titles_refreshed ON media_titles (refreshed_at);
CREATE INDEX IF NOT EXISTS idx_media_titles_tvdb ON media_titles (tvdb_id);

-- TMDB's episodes for a show (same rules as media_titles).
CREATE TABLE IF NOT EXISTS media_episodes (
  tmdb_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  name TEXT,
  air_date TEXT,
  runtime INTEGER,
  still_path TEXT,
  overview TEXT,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (tmdb_id, season, episode)
);

-- Every viewing. A film is one row per time you saw it (season and episode
-- null); a show is one row per episode. `run` is 0 the first time through and
-- counts up for rewatches, so starting again never erases what came before.
-- `skipped` marks an episode passed over on purpose. `source_key` is unique,
-- so an import or a retried request never counts a viewing twice. Rows are
-- never rewritten by a sync: a change is a new row or a delete.
CREATE TABLE IF NOT EXISTS media_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  season INTEGER,
  episode INTEGER,
  watched_at TEXT NOT NULL,
  run INTEGER NOT NULL DEFAULT 0,
  rating REAL,
  skipped INTEGER NOT NULL DEFAULT 0,
  -- app | tvtime | ...
  source TEXT NOT NULL DEFAULT 'app',
  source_key TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_watches_source_key ON media_watches (source_key);
CREATE INDEX IF NOT EXISTS idx_media_watches_item ON media_watches (item_id, run, season, episode);
CREATE INDEX IF NOT EXISTS idx_media_watches_watched_at ON media_watches (watched_at);

-- What the picker landed on and what came of it: picked, not_tonight, started.
CREATE TABLE IF NOT EXISTS media_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  picked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_picks_item ON media_picks (item_id, picked_at);

-- Link the films and shows already on the shelf to TMDB, from their tags.
INSERT OR IGNORE INTO media_links (item_id, media_type, tmdb_id, created_at)
SELECT s.id,
       CASE WHEN s.type = 'movie' THEN 'movie' ELSE 'tv' END,
       CAST(substr(t.value, 9) AS INTEGER),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM shelf_items s, json_each(CASE WHEN json_valid(s.tags_json) THEN s.tags_json ELSE '[]' END) t
WHERE s.type IN ('movie', 'show', 'anime')
  AND t.value LIKE 'tmdb_id:%'
  AND CAST(substr(t.value, 9) AS INTEGER) > 0;
