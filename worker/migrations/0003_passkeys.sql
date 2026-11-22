-- Touch ID / passkey sign-in for owner keys.
-- A passkey is linked to one owner API key; signing in with it yields a
-- short-lived session token that acts as that owner key.

CREATE TABLE IF NOT EXISTS passkeys (
  id           TEXT    PRIMARY KEY,           -- credential ID (base64url)
  key_id       INTEGER NOT NULL REFERENCES api_keys(id),
  public_key   TEXT    NOT NULL,              -- COSE public key (base64url)
  counter      INTEGER NOT NULL DEFAULT 0,    -- signature counter (clone detection)
  transports   TEXT,                          -- JSON array
  rp_id        TEXT    NOT NULL,              -- e.g. commandcenter12.github.io
  label        TEXT,
  backed_up    INTEGER NOT NULL DEFAULT 0,    -- synced passkey (iCloud Keychain etc.)
  created_at   TEXT    NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS passkeys_key ON passkeys(key_id);

-- Single-use challenges, deleted when consumed or after 5 minutes.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge  TEXT    PRIMARY KEY,
  kind       TEXT    NOT NULL,                -- 'register' | 'login'
  key_id     INTEGER,                         -- owner key, for 'register'
  rp_id      TEXT    NOT NULL,
  origin     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Sessions created by passkey sign-in. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  key_id     INTEGER NOT NULL REFERENCES api_keys(id),
  passkey_id TEXT,
  created_at TEXT    NOT NULL,
  expires_at INTEGER NOT NULL                 -- unix seconds
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
