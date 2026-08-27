import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, ensureVecTable, getConfig, setConfig } from '../db/sqlite.js';
import type Database from 'better-sqlite3';

describe('SQLite database layer', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-'));
    db = createDatabase(tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates DB file and all tables', () => {
    const dbFile = path.join(tmpDir, '.simple-rick', 'simple-rick.db');
    expect(fs.existsSync(dbFile)).toBe(true);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);

    expect(names).toContain('sessions');
    expect(names).toContain('turns');
    expect(names).toContain('chunks');
    expect(names).toContain('edges');
    expect(names).toContain('norm_queue');
    expect(names).toContain('config');
  });

  it('getConfig/setConfig round-trip', () => {
    expect(getConfig(db, 'foo')).toBeNull();
    setConfig(db, 'foo', 'bar');
    expect(getConfig(db, 'foo')).toBe('bar');
    setConfig(db, 'foo', 'baz');
    expect(getConfig(db, 'foo')).toBe('baz');
  });

  it('ensureVecTable creates virtual table', () => {
    ensureVecTable(db, 384);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_embeddings'"
    ).all();
    expect(tables.length).toBe(1);
  });
});
