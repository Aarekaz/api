-- Sign in with GitHub for the native apps. One-use OAuth states, and device
-- sessions whose bearer tokens are stored only as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS app_oauth_states (
  state_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash TEXT PRIMARY KEY,
  github_id TEXT NOT NULL,
  github_login TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
