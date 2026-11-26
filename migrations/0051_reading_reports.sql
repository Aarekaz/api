-- Reading time reported by the apps: one row per progress report that carried
-- `seconds` and a `report_id`, so a retried request is credited to reading_days
-- once. Additive only: one new table. See docs/adr/0006-reading-time-from-seconds.md.
--   document_id, report_id  the link and the app's id for this report (a UUID)
--   day                     the day the minutes were credited to
--   seconds                 what was credited, after the clamp (may be less than sent)
--   received_at             server time the report arrived
CREATE TABLE IF NOT EXISTS reading_reports (
  document_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  day TEXT NOT NULL,
  seconds REAL NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (document_id, report_id)
);
