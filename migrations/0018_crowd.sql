-- Layer 3: the crowd. Anonymous visit pings from the living-world site
-- (aarekaz.me). One row per visitor per UTC day, so refreshing never inflates
-- the count. `ts` is the visitor's most recent ping that day, which powers the
-- "tending now" (last-hour) figure.
CREATE TABLE IF NOT EXISTS crowd_visits (
  visitor_hash TEXT NOT NULL,
  day TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  ts INTEGER NOT NULL,      -- epoch ms of the most recent ping that day
  PRIMARY KEY (visitor_hash, day)
);

CREATE INDEX IF NOT EXISTS idx_crowd_visits_ts ON crowd_visits (ts);
