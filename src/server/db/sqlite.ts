import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDatabase(projectPath: string): Database.Database {
  const dir = path.join(projectPath, '.simple-rick');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dir, 'simple-rick.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Run migrations (idempotent)
  try {
    db.exec('ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0');
  } catch {
    // Column already exists — expected
  }

  return db;
}

export function ensureVecTable(db: Database.Database, dimension: number): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding float[${dimension}]
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0(
      note_path TEXT PRIMARY KEY,
      embedding float[${dimension}]
    );
  `);
}

export function getConfig(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setConfig(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
