import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { EmbeddingProvider, ChatProvider } from '../services/ai-providers.js';
import { SessionManager } from '../services/session-manager.js';
import { Recorder } from '../services/recorder.js';
import { VaultWriter } from '../services/vault-writer.js';
import { NoteEmbedder } from '../services/note-embedder.js';
import { LightweightNormalizer } from '../services/lightweight-normalizer.js';
import { DeepNormalizer } from '../services/deep-normalizer.js';
import { EdgeWirer } from '../services/edge-wirer.js';
import { NormQueue } from '../services/norm-queue.js';

const DIMENSION = 4;

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = DIMENSION;
  readonly name = 'mock';
  async embed(_text: string, _inputType?: 'document' | 'query'): Promise<number[]> {
    return [0.1, 0.2, 0.3, 0.4];
  }
}

class MockChatProvider implements ChatProvider {
  readonly name = 'mock';
  private callCount = 0;

  async chat(_system: string, _user: string): Promise<string> {
    this.callCount++;
    // Lightweight normalizer expects: {"entities":[],"domain":"","severity":5}
    // Deep normalizer expects: {"normalized_text":"...","affected":[],"causality":[],"severity":5,"temporal_ref":null,"source_type":"user_input"}
    // Return a response that works for both
    return JSON.stringify({
      entities: ['ComponentA', 'ComponentB'],
      domain: 'Code',
      severity: 7,
      normalized_text: `Normalized chunk ${this.callCount}`,
      affected: ['ComponentA', 'ComponentB'],
      causality: [{ cause: 'ComponentA', effect: 'ComponentB' }],
      temporal_ref: null,
      source_type: 'user_input',
    });
  }
}

describe('End-to-end session flow', () => {
  let tmpDir: string;
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full flow: init → record → normalize → wire → close', async () => {
    // 1. Create temp directory and database
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-rick-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);

    // Load schema
    const schemaPath = path.join(import.meta.dirname, '..', 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    // Create vec tables with dimension 4
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding float[${DIMENSION}]
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0(
        note_path TEXT PRIMARY KEY,
        embedding float[${DIMENSION}]
      );
    `);

    // 2-3. Create mock providers
    const mockEmbedding = new MockEmbeddingProvider();
    const mockChat = new MockChatProvider();

    // 4. Init session
    const sessionManager = new SessionManager(db);
    const sessionId = sessionManager.ensureSession();
    expect(sessionId).toBeTruthy();

    // Setup recorder dependencies
    const vaultPath = path.join(tmpDir, 'vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    const vaultWriter = new VaultWriter(vaultPath);
    const noteEmbedder = new NoteEmbedder(db, mockEmbedding);
    const recorder = new Recorder(db, vaultWriter, noteEmbedder);

    // 5. Record 3 turns
    const turn1 = await recorder.recordMessage(sessionId, 'user', 'How do I implement auth?');
    const turn2 = await recorder.recordMessage(sessionId, 'ai', 'Use JWT tokens with refresh rotation.');
    const turn3 = await recorder.recordMessage(sessionId, 'user', 'Show me the code for token validation.');

    // 6. Verify turns in DB
    const turns = db.prepare('SELECT * FROM turns WHERE session_id = ?').all(sessionId);
    expect(turns).toHaveLength(3);

    // 7. Verify chunks with norm_status = 'pending'
    const chunks = db.prepare("SELECT * FROM chunks WHERE session_id = ? AND norm_status = 'pending'").all(sessionId);
    expect(chunks).toHaveLength(3);

    // 8. Verify norm_queue has 3 pending items
    const queueItems = db.prepare("SELECT * FROM norm_queue WHERE status = 'pending'").all();
    expect(queueItems).toHaveLength(3);

    // 9. Run LightweightNormalizer on each chunk
    const lightNorm = new LightweightNormalizer(db, mockChat);
    const chunkIds = [turn1.chunkId, turn2.chunkId, turn3.chunkId];
    for (const chunkId of chunkIds) {
      await lightNorm.extract(chunkId);
    }

    // 10. Verify chunks updated with entities/domain
    for (const chunkId of chunkIds) {
      const chunk = db.prepare('SELECT entities, domain, severity FROM chunks WHERE id = ?').get(chunkId) as {
        entities: string; domain: string; severity: number;
      };
      expect(JSON.parse(chunk.entities)).toEqual(['ComponentA', 'ComponentB']);
      expect(chunk.domain).toBe('Code');
      expect(chunk.severity).toBe(7);
    }

    // 11. Create DeepNormalizer + EdgeWirer
    const deepNorm = new DeepNormalizer(db, mockChat, mockEmbedding);
    const edgeWirer = new EdgeWirer(db);

    // 12. Create NormQueue, call drain()
    const events: Record<string, unknown>[] = [];
    const normQueue = new NormQueue(db, lightNorm, deepNorm, edgeWirer, (e) => events.push(e), 0);
    const processed = await normQueue.drain(10);
    expect(processed).toBe(3);

    // 13. Verify chunks have norm_status = 'done'
    const doneChunks = db.prepare("SELECT * FROM chunks WHERE session_id = ? AND norm_status = 'done'").all(sessionId);
    expect(doneChunks).toHaveLength(3);

    // 14. Verify edges created
    const edges = db.prepare('SELECT * FROM edges').all();
    expect(edges.length).toBeGreaterThan(0);

    // Verify events were emitted
    expect(events).toHaveLength(3);
    expect(events[0]).toHaveProperty('type', 'chunk:normalized');

    // 15. Close session
    sessionManager.closeSession(sessionId, 'Test session completed');

    // 16. Verify session status = 'closed'
    const session = db.prepare('SELECT status, summary FROM sessions WHERE id = ?').get(sessionId) as {
      status: string; summary: string;
    };
    expect(session.status).toBe('closed');
    expect(session.summary).toBe('Test session completed');

    // 17. Cleanup handled by afterEach
  });
});
