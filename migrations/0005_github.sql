CREATE TABLE IF NOT EXISTS github_daily (
  date TEXT PRIMARY KEY,
  count INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS github_repo_totals (
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  repo TEXT NOT NULL,
  count INTEGER,
  PRIMARY KEY (range_start, range_end, repo)
);
