-- Answers computed from other tables (trips, chapters, footprints), kept so a
-- read doesn't recompute them while their data hasn't changed. Additive only:
-- one new table. See services/derived-cache.ts and docs/adr/0002-derived-cache.md.
--   name, params   what was computed and from which query (one row each, overwritten)
--   data_name      the data_versions row it was built from ("places")
--   data_version   that row's version read before building; the row is valid
--                  only while data_versions still says the same
--   shape          the code that built it (a change invalidates every row)
--   storage        'd1': body holds the JSON; 'r2': the JSON is in R2_PRIVATE at
--                  derived-cache/<name>/<params>.json (too big for a row)
--   lease_until    set while one request builds it, so others wait instead of
--                  all rebuilding at once
-- Nothing here is the owner's data: the backup skips it and it can be emptied
-- at any time.
CREATE TABLE IF NOT EXISTS derived_cache (
  name TEXT NOT NULL,
  params TEXT NOT NULL,
  data_name TEXT NOT NULL,
  data_version INTEGER NOT NULL,
  shape TEXT NOT NULL,
  storage TEXT NOT NULL DEFAULT 'd1',
  bytes INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  built_at TEXT NOT NULL,
  build_ms INTEGER,
  lease_until TEXT,
  PRIMARY KEY (name, params)
);
