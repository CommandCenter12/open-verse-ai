-- Things the owner told Open Verse Ai to remember, plus corrections.
-- Learned conversations go into memory_fts with source = 'openverse'.
CREATE TABLE IF NOT EXISTS memory_facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,   -- 'fact' | 'preference' | 'correction'
  text       TEXT    NOT NULL,
  context    TEXT,               -- for corrections: the question it corrects
  created_at TEXT    NOT NULL
);
