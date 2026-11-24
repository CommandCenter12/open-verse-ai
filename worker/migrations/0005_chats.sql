-- Saved chats for the chat page (owner only): folders, chats and their messages.
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT    PRIMARY KEY,
  title      TEXT    NOT NULL DEFAULT 'New chat',
  folder_id  TEXT    REFERENCES folders(id) ON DELETE SET NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at);
CREATE INDEX IF NOT EXISTS chats_folder ON chats(folder_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL,           -- 'user' | 'assistant'
  content    TEXT    NOT NULL,
  meta       TEXT,                       -- JSON: mode, model, sources, calculations, …
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, id);
