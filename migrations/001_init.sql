-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  api_key_hash TEXT NOT NULL,
  plan TEXT DEFAULT 'free',
  created_at INTEGER NOT NULL
);

-- Pools
CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT,
  is_default INTEGER DEFAULT 0,
  overflow_pool_id TEXT,
  routing_rules TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Drive accounts
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  access_token_expires INTEGER,
  storage_limit_bytes INTEGER DEFAULT 15000000000,
  daily_upload_limit_bytes INTEGER DEFAULT 750000000000,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (pool_id) REFERENCES pools(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- File/data index
CREATE TABLE IF NOT EXISTS files_index (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  data_type TEXT NOT NULL,
  app_id TEXT,
  collection TEXT,
  kv_key TEXT,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER DEFAULT 0,
  replicated INTEGER DEFAULT 0,
  replica_account_id TEXT,
  replica_drive_file_id TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pool_id TEXT,
  account_id TEXT,
  action TEXT NOT NULL,
  bytes INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  error_message TEXT,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);

-- OAuth state (CSRF protection during OAuth flow)
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_user ON files_index(user_id);
CREATE INDEX IF NOT EXISTS idx_files_type ON files_index(user_id, data_type);
CREATE INDEX IF NOT EXISTS idx_files_collection ON files_index(user_id, collection);
CREATE INDEX IF NOT EXISTS idx_files_kv ON files_index(user_id, kv_key);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_accounts_pool ON accounts(pool_id);
CREATE INDEX IF NOT EXISTS idx_pools_user ON pools(user_id);
