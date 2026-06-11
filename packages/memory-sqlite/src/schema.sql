CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  tags        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_metadata (
  memory_id           INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  folder_path         TEXT    NOT NULL DEFAULT 'inbox',
  status              TEXT    NOT NULL DEFAULT 'active',
  canonical_page_path TEXT,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_metadata_folder_idx ON memory_metadata(folder_path);
CREATE INDEX IF NOT EXISTS memory_metadata_status_idx ON memory_metadata(status);

CREATE TRIGGER IF NOT EXISTS memories_meta_ai AFTER INSERT ON memories BEGIN
  INSERT OR IGNORE INTO memory_metadata(memory_id, folder_path, status, updated_at)
  VALUES (new.id, 'inbox', 'active', new.created_at);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content='memories',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS wiki_folders (
  path       TEXT    PRIMARY KEY,
  title      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wiki_pages (
  path              TEXT    PRIMARY KEY,
  folder_path       TEXT    NOT NULL REFERENCES wiki_folders(path) ON DELETE CASCADE,
  title             TEXT    NOT NULL,
  content           TEXT    NOT NULL,
  tags              TEXT    NOT NULL DEFAULT '',
  source_memory_ids TEXT    NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS wiki_pages_folder_idx ON wiki_pages(folder_path);
CREATE INDEX IF NOT EXISTS wiki_pages_updated_idx ON wiki_pages(updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
  title,
  content,
  tags,
  content='wiki_pages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, content, tags)
  VALUES('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, content, tags)
  VALUES('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO wiki_pages_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS wiki_links (
  from_path  TEXT    NOT NULL REFERENCES wiki_pages(path) ON DELETE CASCADE,
  to_path    TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'related',
  created_at INTEGER NOT NULL,
  PRIMARY KEY(from_path, to_path, kind)
);

CREATE INDEX IF NOT EXISTS wiki_links_to_idx ON wiki_links(to_path);

CREATE TABLE IF NOT EXISTS wiki_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  event_type    TEXT    NOT NULL,
  message       TEXT    NOT NULL,
  metadata_json TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS wiki_log_ts_idx ON wiki_log(ts);

CREATE TABLE IF NOT EXISTS memory_maintenance_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT    NOT NULL,
  memory_id      INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  payload_json   TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending',
  attempts       INTEGER NOT NULL DEFAULT 0,
  available_at   INTEGER NOT NULL,
  claimed_at     INTEGER,
  worker_id      TEXT,
  last_error     TEXT,
  result_summary TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_maintenance_jobs_pending_idx
  ON memory_maintenance_jobs(status, available_at, id);

CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id         INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  tool_calls_json TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conv_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  skill           TEXT    NOT NULL,
  args_json       TEXT    NOT NULL,
  result_summary  TEXT    NOT NULL,
  ok              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log(ts);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT    PRIMARY KEY,
  channel          TEXT    NOT NULL,
  agent            TEXT    NOT NULL DEFAULT 'default',
  status           TEXT    NOT NULL DEFAULT 'active',
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_channel_idx ON sessions(channel);
CREATE INDEX IF NOT EXISTS sessions_activity_idx ON sessions(last_activity_at);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT,
  name        TEXT    NOT NULL,
  prompt      TEXT    NOT NULL,
  schedule    TEXT    NOT NULL,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS cron_jobs_next_idx ON cron_jobs(next_run_at);

CREATE TABLE IF NOT EXISTS channel_allowlist (
  channel    TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code        TEXT    PRIMARY KEY,
  channel     TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pairing_codes_channel_idx ON pairing_codes(channel);
CREATE INDEX IF NOT EXISTS pairing_codes_expires_idx ON pairing_codes(expires_at);
