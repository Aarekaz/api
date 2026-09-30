-- Project distribution metadata for the public website:
--   listings_json: JSON array of { platform, status, url } (NULL reads as [])
--   featured:      boolean flag (0/1), defaults to not featured
--   highlight:     short headline stat, e.g. "2K+ daily riders"
ALTER TABLE projects ADD COLUMN listings_json TEXT;
ALTER TABLE projects ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN highlight TEXT;
