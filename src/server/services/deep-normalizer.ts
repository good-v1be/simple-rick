import type Database from 'better-sqlite3';
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
    const parsed = JSON.parse(result.match(/\{[\s\S]*\}/)?.[0] ?? '{}');

    // 2. Embed normalized text (providers throw on failure)
    const normalizedText = parsed.normalized_text ?? chunk.content;
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
      JSON.stringify(parsed.affected ?? []),
      JSON.stringify(parsed.causality ?? []),
      parsed.severity ?? 5,
      parsed.temporal_ref ?? null,
      parsed.source_type ?? 'user_input',
      chunkId
    );

    // 4. Store embedding in sqlite-vec
    this.db.prepare(
      'INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)'
    ).run(chunkId, Buffer.from(new Float32Array(vector).buffer));
  }
}
