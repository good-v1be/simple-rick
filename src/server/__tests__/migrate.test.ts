import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from '../db/migrate.js';
import { assertEmbeddingCompatible } from '../db/sqlite.js';

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE edges (id INTEGER PRIMARY KEY)');
  return db;
}

describe('runMigrations', () => {
  it('applies every migration on a fresh database', () => {
    const db = freshDb();
    expect(runMigrations(db)).toEqual(MIGRATIONS.map(m => m.version));
    const cols = (db.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('confidence');
  });

  it('is a no-op on the second run', () => {
    const db = freshDb();
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
  });

  it('records what it applied', () => {
    const db = freshDb();
    runMigrations(db);
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toHaveLength(MIGRATIONS.length);
  });

  it('adopts a database that already has the column, without failing', () => {
    // Databases created before the migration runner existed already had
    // `confidence` added by the old ad-hoc ALTER.
    const db = freshDb();
    db.exec('ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0');
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get())
      .toEqual({ v: Math.max(...MIGRATIONS.map(m => m.version)) });
  });
});

describe('assertEmbeddingCompatible', () => {
  it('passes on a fresh database with nothing stored yet', () => {
    expect(() => assertEmbeddingCompatible(
      { provider: null, dimension: null },
      { provider: 'openai', dimension: 1536 },
    )).not.toThrow();
  });

  it('passes when the dimension matches', () => {
    expect(() => assertEmbeddingCompatible(
      { provider: 'openai', dimension: 1536 },
      { provider: 'openai', dimension: 1536 },
    )).not.toThrow();
  });

  it('throws with recovery instructions when the dimension changed', () => {
    expect(() => assertEmbeddingCompatible(
      { provider: 'voyage', dimension: 1024 },
      { provider: 'openai', dimension: 1536 },
    )).toThrow(/dimension mismatch[\s\S]*DROP TABLE/);
  });
});
