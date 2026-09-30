-- Spotify now-playing integration: a single owner connection with encrypted OAuth
-- tokens, one-use OAuth states, and a short-lived cache of the last /v1/music/now result.

CREATE TABLE IF NOT EXISTS spotify_connections (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'needs_reauth', 'disconnected')),
  access_token_ciphertext TEXT,
  access_token_nonce TEXT,
  access_token_expires_at TEXT,
  refresh_token_ciphertext TEXT,
  refresh_token_nonce TEXT,
  granted_scopes TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  connected_at TEXT,
  refreshed_at TEXT,
  disconnected_at TEXT,
  now_json TEXT,
  now_fetched_at TEXT,
  rate_limited_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spotify_oauth_states (
  state_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
