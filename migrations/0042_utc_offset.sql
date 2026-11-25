-- The local time of a visit or journey is where it happened, not where the phone
-- is now: a day in Kathmandu is UTC+5:45 even when read from New York. Minutes
-- from UTC at that moment (DST included). Null means unknown (the reader's offset
-- is used). Additive only: two nullable columns.
ALTER TABLE visits ADD COLUMN utc_offset INTEGER;
ALTER TABLE journeys ADD COLUMN utc_offset INTEGER;
