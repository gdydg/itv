-- D1 schema for replacing KV-based storage in this worker.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  ip_limit INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  owner_username TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_username) REFERENCES users(username) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_owner ON tokens(owner_username);
CREATE INDEX IF NOT EXISTS idx_tokens_expires_at ON tokens(expires_at);

CREATE TABLE IF NOT EXISTS token_ips (
  token TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (token, ip),
  FOREIGN KEY (token) REFERENCES tokens(token) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_token_ips_token ON token_ips(token);

CREATE TABLE IF NOT EXISTS user_tokens (
  username TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (username, token),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE,
  FOREIGN KEY (token) REFERENCES tokens(token) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  logo TEXT,
  channel_group TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(channel_group);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (provider, external_id),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oauth_username ON oauth_accounts(username);
