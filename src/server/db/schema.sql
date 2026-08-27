CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  summary TEXT,
  learnings TEXT,
  status TEXT DEFAULT 'active',
  domain TEXT,
  tags TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_num INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  content TEXT NOT NULL,
  normalized_text TEXT,
  domain TEXT DEFAULT 'Miscellaneous',
  entities TEXT,
  affected TEXT,
  causality TEXT,
  severity INTEGER DEFAULT 5,
  temporal_ref TEXT,
  source_type TEXT,
  source_file TEXT,
  norm_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_entity TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  edge_type TEXT DEFAULT 'bidirectional',
  severity INTEGER DEFAULT 5,
  causality_direction TEXT,
  confirmation_count INTEGER DEFAULT 1,
  source_chunk_ids TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_entity, target_entity, edge_type)
);

CREATE TABLE IF NOT EXISTS norm_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL REFERENCES chunks(id),
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  timestamp_ms INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  diff TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_chunks_norm_status ON chunks(norm_status);
CREATE INDEX IF NOT EXISTS idx_chunks_domain ON chunks(domain);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_entity);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_entity);
CREATE INDEX IF NOT EXISTS idx_norm_queue_status ON norm_queue(status);
