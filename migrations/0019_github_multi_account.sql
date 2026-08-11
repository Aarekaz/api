ALTER TABLE github_daily
  ADD COLUMN personal_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE github_daily
  ADD COLUMN work_count INTEGER NOT NULL DEFAULT 0;

UPDATE github_daily
SET personal_count = COALESCE(count, 0),
    work_count = 0;
