-- Owner-only personal memory (chat-history chunks + profile) and key scopes.
-- The FTS table is created first: if FTS5 were unavailable, nothing else changes.

-- One row per chunk. title/body are searchable; the rest is metadata.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title,
  body,
  source UNINDEXED,     -- 'claude' | 'gemini'
  conv_date UNINDEXED,  -- YYYY-MM-DD
  chunk_id UNINDEXED,
  tokenize = 'porter unicode61'
);

-- Single-row, hand-edited profile summary.
CREATE TABLE IF NOT EXISTS memory_profile (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  text       TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

-- 'public' keys come from POST /v1/keys. 'owner' keys are inserted only by
-- scripts/memory/owner-key.mjs and are the only keys that can read memory.
ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'public';
