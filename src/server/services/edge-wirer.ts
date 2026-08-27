import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export class EdgeWirer {
  constructor(private db: Database.Database) {}

  wireFromChunk(chunkId: string): { newEdges: Array<{ source: string; target: string; type: string }> } {
    const chunk = this.db.prepare(
      'SELECT affected, causality, severity FROM chunks WHERE id = ?'
    ).get(chunkId) as { affected: string; causality: string; severity: number };

    const affected: string[] = JSON.parse(chunk.affected || '[]');
    const causality: Array<{ cause: string; effect: string }> = JSON.parse(chunk.causality || '[]');
    const newEdges: Array<{ source: string; target: string; type: string }> = [];

    // Causality edges
    for (const { cause, effect } of causality) {
      if (cause && effect) {
        this._upsertEdge(cause, effect, 'unidirectional', chunk.severity, `${cause} → ${effect}`, chunkId);
        newEdges.push({ source: cause, target: effect, type: 'unidirectional' });
      }
    }

    // Co-occurrence edges
    for (let i = 0; i < affected.length; i++) {
      for (let j = i + 1; j < affected.length; j++) {
        this._upsertEdge(affected[i], affected[j], 'bidirectional', chunk.severity, null, chunkId);
        newEdges.push({ source: affected[i], target: affected[j], type: 'bidirectional' });
      }
    }

    return { newEdges };
  }

  private _upsertEdge(source: string, target: string, type: string, severity: number, direction: string | null, chunkId: string): void {
    const existing = this.db.prepare(
      'SELECT id, source_chunk_ids, confirmation_count FROM edges WHERE source_entity = ? AND target_entity = ? AND edge_type = ?'
    ).get(source, target, type) as { id: string; source_chunk_ids: string; confirmation_count: number } | undefined;

    if (existing) {
      const ids = JSON.parse(existing.source_chunk_ids || '[]');
      ids.push(chunkId);
      this.db.prepare(
        "UPDATE edges SET confirmation_count = ?, source_chunk_ids = ?, severity = MAX(severity, ?), updated_at = datetime('now') WHERE id = ?"
      ).run(existing.confirmation_count + 1, JSON.stringify(ids), severity, existing.id);
    } else {
      this.db.prepare(
        'INSERT INTO edges (id, source_entity, target_entity, edge_type, severity, causality_direction, source_chunk_ids) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(crypto.randomUUID(), source, target, type, severity, direction, JSON.stringify([chunkId]));
    }
  }
}
