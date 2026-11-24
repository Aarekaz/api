-- Minutes read per article per day, added as reading progress moves forward.
-- Feeds reading stats (time read, days read, streak). Additive only.
CREATE TABLE IF NOT EXISTS reading_days (
  day TEXT NOT NULL,
  document_id TEXT NOT NULL,
  minutes REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, document_id)
);
CREATE INDEX IF NOT EXISTS reading_days_day ON reading_days(day);
