-- Open Verse Ai D1 schema, part 1. Plaintext API keys are NEVER stored.
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash     TEXT    NOT NULL UNIQUE,   -- hex SHA-256 of the full key
  prefix       TEXT    NOT NULL,          -- first 12 chars, for display only
  label        TEXT,
  created_at   TEXT    NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

-- Fixed-window counters for rate limits and quotas.
CREATE TABLE IF NOT EXISTS counters (
  bucket     TEXT    PRIMARY KEY,         -- e.g. ask:m:<hash>:<minute>
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL             -- unix seconds
);
CREATE INDEX IF NOT EXISTS counters_expires ON counters(expires_at);
