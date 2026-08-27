import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from './ai-providers.js';

export interface SearchResult {
  note_path: string;
  score: number;
}

export class NoteEmbedder {
  constructor(
    private db: Database.Database,
    private embedding: EmbeddingProvider | null,
  ) {}

  async embedNote(notePath: string, content: string): Promise<void> {
    if (!this.embedding) return;
    const vector = await this.embedding.embed(content, 'document');
    if (!vector) return;
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.db.prepare(
      'INSERT OR REPLACE INTO note_embeddings (note_path, embedding) VALUES (?, ?)'
    ).run(notePath, buf);
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    if (!this.embedding) return [];
    const vector = await this.embedding.embed(query, 'query');
    if (!vector) return [];
    const rows = this.db.prepare(
      `SELECT note_path, distance
       FROM note_embeddings
       WHERE embedding MATCH ?
       ORDER BY distance ASC
       LIMIT ?`
    ).all(Buffer.from(new Float32Array(vector).buffer), limit) as Array<{ note_path: string; distance: number }>;
    // Convert distance to score (lower distance = higher score)
    return rows
      .map(r => ({ note_path: r.note_path, score: 1 / (1 + r.distance) }))
      .filter(r => r.score >= 0.3);
  }

  async updatePath(oldPath: string, newPath: string): Promise<void> {
    // sqlite-vec virtual tables don't support UPDATE on rowid,
    // so read embedding, delete old, insert new
    const row = this.db.prepare(
      'SELECT embedding FROM note_embeddings WHERE note_path = ?'
    ).get(oldPath) as { embedding: Buffer } | undefined;
    if (!row) return;
    this.db.prepare('DELETE FROM note_embeddings WHERE note_path = ?').run(oldPath);
    this.db.prepare('INSERT INTO note_embeddings (note_path, embedding) VALUES (?, ?)').run(newPath, row.embedding);
  }
}
