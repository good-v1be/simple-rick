import type Database from 'better-sqlite3';
import { extractObject, asString, asStringArray, asInt, filterValid } from './ai-json.js';
import type { ChatProvider, EmbeddingProvider } from './ai-providers.js';

export class DeepNormalizer {
  constructor(
    private db: Database.Database,
    private chat: ChatProvider,
    private embedding: EmbeddingProvider,
  ) {}

  async normalize(chunkId: string): Promise<void> {
    const chunk = this.db.prepare(
      'SELECT content, domain, entities FROM chunks WHERE id = ?'
    ).get(chunkId) as { content: string; domain: string; entities: string };
    if (!chunk) throw new Error(`Chunk ${chunkId} not found`);

    // 1. LLM normalization
    const result = await this.chat.chat(
      `Normalize this coding session chunk. Return JSON:
{"normalized_text":"clear summary","affected":["entity1"],"causality":[{"cause":"x","effect":"y"}],"severity":5,"temporal_ref":null,"source_type":"user_input"}`,
      chunk.content
    );
    const parsed = extractObject(result, 'deep-norm');

    // 2. Embed normalized text (providers throw on failure)
    const normalizedText = asString(parsed['normalized_text'], chunk.content, 'deep-norm', 'normalized_text');
    const affected = asStringArray(parsed['affected'], 'deep-norm', 'affected');
    const causality = asCausality(parsed['causality']);
    const severity = asInt(parsed['severity'], { min: 1, max: 10, fallback: 5 }, 'deep-norm', 'severity');
    const temporalRef = typeof parsed['temporal_ref'] === 'string' ? parsed['temporal_ref'] : null;
    const sourceType = asString(parsed['source_type'], 'user_input', 'deep-norm', 'source_type');
    let vector: number[];
    try {
      vector = await this.embedding.embed(normalizedText, 'document');
    } catch (err) {
      console.error(`[deep-norm] Embedding failed for ${chunkId}, skipping vector:`, err);
      this.db.prepare(`UPDATE chunks SET normalized_text = ?, norm_status = 'done' WHERE id = ?`)
        .run(normalizedText, chunkId);
      return;
    }

    // 3. Update chunk
    this.db.prepare(`UPDATE chunks SET
      normalized_text = ?, affected = ?, causality = ?,
      severity = ?, temporal_ref = ?, source_type = ?, norm_status = 'done'
      WHERE id = ?`
    ).run(
      normalizedText,
      JSON.stringify(affected),
      JSON.stringify(causality),
      severity,
      temporalRef,
      sourceType,
      chunkId
    );

    // 4. Store embedding in sqlite-vec
    this.db.prepare(
      'INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)'
    ).run(chunkId, Buffer.from(new Float32Array(vector).buffer));
  }
}

/** Keep only well-formed {cause, effect} pairs; the model sometimes returns strings. */
function asCausality(value: unknown): Array<{ cause: string; effect: string }> {
  if (!Array.isArray(value)) return [];
  return filterValid(
    value,
    (item): item is { cause: string; effect: string } =>
      typeof item === 'object' && item !== null &&
      typeof (item as { cause?: unknown }).cause === 'string' &&
      typeof (item as { effect?: unknown }).effect === 'string',
    'deep-norm',
    'causality pairs',
  );
}
