import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';

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
  runMigrations(db);

  return db;
}

/**
 * Embedding vectors are stored in fixed-width vec0 tables, so the dimension is
 * baked into the schema on first run. Switching to a provider with a different
 * dimension silently produced unusable vectors; refuse to start instead and say
 * what to do about it.
 */
export function assertEmbeddingCompatible(
  stored: { provider: string | null; dimension: number | null },
  actual: { provider: string; dimension: number },
): void {
  if (stored.dimension === null || stored.dimension === actual.dimension) return;

  throw new Error(
    `Embedding dimension mismatch: this database was built with ` +
    `${stored.provider ?? 'an unknown provider'} (${stored.dimension} dimensions), ` +
    `but the configured provider is ${actual.provider} (${actual.dimension} dimensions). ` +
    `Existing vectors cannot be queried with the new provider.\n\n` +
    `Either set the previous provider's API key again, or drop the embeddings and let them rebuild:\n` +
    `  sqlite3 .simple-rick/simple-rick.db "DROP TABLE IF EXISTS chunk_embeddings; DROP TABLE IF EXISTS note_embeddings; ` +
    `DELETE FROM config WHERE key IN ('embedding_provider','embedding_dimension');"`,
  );
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
