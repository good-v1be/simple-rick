/**
 * Schema migrations.
 *
 * Deliberately small: the database is a single local file owned by one process,
 * so there is no need for a migration framework. What was missing was the part
 * that actually matters — a record of which migrations have run, so that
 * changes are applied exactly once and in order instead of being retried on
 * every start and swallowed by a bare `catch`.
 *
 * To add a migration, append to MIGRATIONS. Never edit or reorder an existing
 * entry: its version is already recorded in every database out there.
 */

import type Database from 'better-sqlite3';
import { logInfo } from '../log.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/** Add a column, treating "already exists" as success. */
function addColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (existing.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'edges.confidence',
    up: db => addColumn(db, 'edges', 'confidence', 'REAL DEFAULT 1.0'),
  },
];

function currentVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row?.v ?? 0;
}

/**
 * Apply every migration newer than the recorded version, each in its own
 * transaction so a failure leaves the database at the last good version.
 * Returns the versions that were applied.
 */
export function runMigrations(db: Database.Database): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const from = currentVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > from).sort((a, b) => a.version - b.version);
  const applied: number[] = [];

  for (const migration of pending) {
    const run = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
    });
    run();
    applied.push(migration.version);
    logInfo('migrate', `applied migration ${migration.version} (${migration.name})`);
  }

  return applied;
}
