import type Database from 'better-sqlite3';

/**
 * When new data contradicts an existing insight, reduce confidence.
 * If confidence drops below 0.3, invalidate the insight.
 */
export function decayContradicted(
  db: Database.Database,
  newChunkId: string,
): { decayed: number; invalidated: number } {
  let decayed = 0;
  let invalidated = 0;

  // Get entities from the new chunk
  const newChunk = db.prepare(
    'SELECT entities FROM chunks WHERE id = ?'
  ).get(newChunkId) as { entities: string } | undefined;

  if (!newChunk?.entities) return { decayed, invalidated };

  let newEntities: string[];
  try {
    const parsed = JSON.parse(newChunk.entities);
    newEntities = parsed.map((e: unknown) => typeof e === 'string' ? e : (e as any)?.name ?? '').filter(Boolean);
  } catch {
    return { decayed, invalidated };
  }

  if (newEntities.length === 0) return { decayed, invalidated };

  // Find insight edges that involve these entities
  const insightEdges = db.prepare(
    `SELECT id, source_entity, target_entity, confidence FROM edges
     WHERE edge_type = 'insight' AND confidence > 0`
  ).all() as { id: string; source_entity: string; target_entity: string; confidence: number }[];

  for (const edge of insightEdges) {
    const overlaps = newEntities.some(
      e => e === edge.source_entity || e === edge.target_entity
    );
    if (!overlaps) continue;

    const newConfidence = edge.confidence - 0.1;

    if (newConfidence < 0.3) {
      // Invalidate
      db.prepare(
        'UPDATE edges SET confidence = 0, updated_at = datetime(\'now\') WHERE id = ?'
      ).run(edge.id);

      // Mark insight chunks as invalidated
      db.prepare(
        `UPDATE chunks SET norm_status = 'invalidated'
         WHERE source_type = 'insight' AND source_file LIKE 'insight:%'
           AND id IN (SELECT value FROM json_each(
             (SELECT source_chunk_ids FROM edges WHERE id = ?)
           ))`
      ).run(edge.id);

      invalidated++;
    } else {
      db.prepare(
        'UPDATE edges SET confidence = ?, updated_at = datetime(\'now\') WHERE id = ?'
      ).run(newConfidence, edge.id);
      decayed++;
    }
  }

  return { decayed, invalidated };
}
