import type Database from 'better-sqlite3';
import type { ChatProvider, EmbeddingProvider } from '../ai-providers.js';
import { detectSignals, type SignalCandidate } from './signal-detector.js';
import { buildValidatePrompt, buildCausalChainPrompt } from './prompts.js';
import crypto from 'node:crypto';
import { extractObject, asString, asInt } from '../ai-json.js';
import { logWarn } from '../../log.js';

type BroadcastFn = (event: Record<string, unknown>) => void;

interface ValidationResult {
  is_valid: boolean;
  confidence: number;
  causal_direction: string;
  conversational_summary: string;
}

function parseValidation(raw: string): ValidationResult | null {
  const parsed = extractObject(raw, 'insight');
  if (typeof parsed['is_valid'] !== 'boolean') {
    logWarn('insight', 'validation response had no boolean is_valid, discarding', parsed);
    return null;
  }
  return {
    is_valid: parsed['is_valid'],
    confidence: asInt(
      typeof parsed['confidence'] === 'number' ? Math.round(parsed['confidence'] * 100) : parsed['confidence'],
      { min: 0, max: 100, fallback: 0 }, 'insight', 'confidence',
    ) / 100,
    causal_direction: asString(parsed['causal_direction'], 'none', 'insight', 'causal_direction'),
    conversational_summary: asString(parsed['conversational_summary'], '', 'insight', 'conversational_summary'),
  };
}

export class InsightEngine {
  constructor(
    private db: Database.Database,
    private chat: ChatProvider,
    private embedding: EmbeddingProvider | null,
    private broadcast?: BroadcastFn,
  ) {}

  /**
   * Analyze after a chunk is normalized. Skips if domain has < 5 chunks.
   */
  async analyzeAfterNormalization(chunkId: string): Promise<void> {
    const chunk = this.db.prepare(
      'SELECT domain FROM chunks WHERE id = ?'
    ).get(chunkId) as { domain: string } | undefined;
    if (!chunk?.domain) return;

    const { count } = this.db.prepare(
      `SELECT COUNT(*) as count FROM chunks WHERE domain = ? AND norm_status = 'done'`
    ).get(chunk.domain) as { count: number };

    if (count < 5) return;

    await this._analyzeForDomain(chunk.domain, chunkId);
  }

  /**
   * Deep scan: iterate all domains with 5+ chunks and run full analysis.
   */
  async deepScan(): Promise<{ log: string[]; insightsCreated: number }> {
    const log: string[] = [];
    let insightsCreated = 0;

    const domains = this.db.prepare(
      `SELECT domain, COUNT(*) as count FROM chunks
       WHERE norm_status = 'done' AND domain IS NOT NULL
       GROUP BY domain HAVING COUNT(*) >= 5`
    ).all() as { domain: string; count: number }[];

    log.push(`Found ${domains.length} domain(s) with 5+ chunks: ${domains.map(d => `${d.domain} (${d.count})`).join(', ')}`);

    for (const { domain } of domains) {
      log.push(`Scanning domain: ${domain}`);
      const created = await this._analyzeForDomainWithLog(domain, log);
      insightsCreated += created;
    }

    if (domains.length === 0) {
      log.push('No domains with 5+ chunks found — need more data');
    }

    log.push(`Scan complete: ${insightsCreated} insight(s) created`);

    if (this.broadcast) {
      this.broadcast({ type: 'graph:updated' });
    }

    return { log, insightsCreated };
  }

  /**
   * Semantic scan: find related chunks via embedding similarity, then ask LLM
   * to identify cross-document insights.
   */
  async semanticScan(): Promise<{ log: string[]; insightsCreated: number }> {
    const log: string[] = [];
    let insightsCreated = 0;

    if (!this.embedding) {
      log.push('No embedding provider — skipping semantic scan');
      return { log, insightsCreated };
    }

    // Use chunk_embeddings to find similar pairs
    // SQLite vec0 doesn't support cross-join similarity easily,
    // so we do a simpler approach: pick recent chunks and search for similar ones
    const recentChunks = this.db.prepare(
      `SELECT id, content, source_file, domain FROM chunks
       WHERE norm_status = 'done' AND domain != 'system' AND content IS NOT NULL
       ORDER BY created_at DESC LIMIT 20`
    ).all() as { id: string; content: string; source_file: string; domain: string }[];

    log.push(`Checking ${recentChunks.length} recent chunks for semantic connections`);

    const seen = new Set<string>();

    for (const chunk of recentChunks) {
      // Get embedding for this chunk
      let queryEmb: number[];
      try {
        queryEmb = await this.embedding.embed(chunk.content.slice(0, 2000), 'query');
      } catch {
        continue;
      }

      // Search for similar chunks (different source)
      let similar: { chunk_id: string; distance: number }[];
      try {
        similar = this.db.prepare(
          `SELECT chunk_id, distance FROM chunk_embeddings
           WHERE embedding MATCH ? AND k = 5`
        ).all(Buffer.from(new Float32Array(queryEmb).buffer)) as any[];
      } catch {
        // vec0 not available or no embeddings
        log.push('Embedding search not available — skipping');
        break;
      }

      for (const match of similar) {
        if (match.chunk_id === chunk.id) continue;
        if (match.distance > 0.5) continue; // too far

        const matchChunk = this.db.prepare(
          'SELECT content, source_file, domain FROM chunks WHERE id = ?'
        ).get(match.chunk_id) as { content: string; source_file: string; domain: string } | undefined;

        if (!matchChunk || matchChunk.source_file === chunk.source_file) continue;

        const pairKey = [chunk.id, match.chunk_id].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const similarity = 1 - match.distance;
        if (similarity < 0.75) continue;

        log.push(`  Analyzing: "${chunk.source_file}" ↔ "${matchChunk.source_file}" (similarity: ${similarity.toFixed(2)})`);

        const prompt = `You are analyzing two text chunks from different documents that are semantically similar.

Chunk A (from ${chunk.source_file}):
${chunk.content.slice(0, 500)}

Chunk B (from ${matchChunk.source_file}):
${matchChunk.content.slice(0, 500)}

Identify the connection between these chunks. What insight or relationship do they reveal?

Return ONLY JSON:
{
  "is_valid": true/false,
  "confidence": 0.0-1.0,
  "connection_type": "supports|contradicts|extends|complements|same_topic",
  "conversational_summary": "One sentence describing the insight"
}`;

        try {
          const raw = await this.chat.chat(
            'You are an analytical assistant. Identify connections between text chunks.',
            prompt,
          );
          const parsed = parseValidation(raw);
          if (!parsed?.is_valid || (parsed.confidence ?? 0) < 0.6) {
            log.push(`    ✗ Rejected`);
            continue;
          }

          log.push(`    ✓ ${parsed.conversational_summary} (${(parsed.confidence * 100).toFixed(0)}%)`);

          // Store insight
          const insightId = crypto.randomUUID();
          this.db.prepare(
            `INSERT INTO chunks (id, session_id, content, domain, source_type, source_file, norm_status)
             VALUES (?, (SELECT id FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1),
                     ?, ?, 'insight', 'insight', 'done')`
          ).run(insightId, parsed.conversational_summary, chunk.domain);

          // Store insight edge
          this._storeInsightEdge(
            chunk.source_file || chunk.id,
            matchChunk.source_file || match.chunk_id,
            parsed.confidence,
            parsed.causal_direction,
            insightId,
          );

          insightsCreated++;
          if (this.broadcast) {
            this.broadcast({ type: 'flow:insight', stage: 'complete', chunkId: insightId });
          }
        } catch (err) {
          log.push(`    ✗ Error: ${(err as Error).message?.slice(0, 80)}`);
        }
      }
    }

    log.push(`Semantic scan complete: ${insightsCreated} insight(s) created`);
    if (this.broadcast) this.broadcast({ type: 'graph:updated' });
    return { log, insightsCreated };
  }

  /**
   * Find A->B->C transitive causal chains among insight edges.
   */
  async findTransitiveChains(): Promise<{ log: string[]; chainsFound: number }> {
    const log: string[] = [];
    let chainsFound = 0;

    const insightEdges = this.db.prepare(
      `SELECT id, source_entity, target_entity, causality_direction, confidence
       FROM edges WHERE edge_type = 'insight' AND confidence >= 0.7
         AND causality_direction IS NOT NULL`
    ).all() as {
      id: string; source_entity: string; target_entity: string;
      causality_direction: string; confidence: number;
    }[];

    if (insightEdges.length < 2) {
      log.push('Need at least 2 insight edges for transitive chains');
      return { log, chainsFound };
    }

    // Build adjacency
    const adj = new Map<string, { target: string; edgeId: string }[]>();
    for (const e of insightEdges) {
      const dir = e.causality_direction;
      if (!dir || dir === 'none' || dir === 'bidirectional') continue;
      const parts = dir.split('->').map(s => s.trim());
      if (parts.length !== 2) continue;
      const [src, tgt] = parts;
      if (!adj.has(src)) adj.set(src, []);
      adj.get(src)!.push({ target: tgt, edgeId: e.id });
    }

    // Find 2-hop chains
    for (const [a, neighbors] of adj) {
      for (const { target: b } of neighbors) {
        for (const { target: c } of adj.get(b) ?? []) {
          if (c === a) continue;

          const chainStr = `${a} -> ${b} -> ${c}`;
          log.push(`  Evaluating chain: ${chainStr}`);

          const prompt = buildCausalChainPrompt(chainStr);
          try {
            const raw = await this.chat.chat(
              'You are an analytical assistant. Check transitive causal chains.',
              prompt,
            );
            const result = parseValidation(raw);
            if (!result?.is_valid || result.confidence < 0.7) {
              log.push(`    ✗ Rejected`);
              continue;
            }

            log.push(`    ✓ ${result.conversational_summary} (${(result.confidence * 100).toFixed(0)}%)`);

            // Store transitive insight
            const insightId = crypto.randomUUID();
            this.db.prepare(
              `INSERT INTO chunks (id, session_id, content, domain, source_type, source_file, norm_status)
               VALUES (?, (SELECT id FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1),
                       ?, 'general', 'insight', 'insight:transitive', 'done')`
            ).run(insightId, result.conversational_summary);

            this._storeInsightEdge(a, c, result.confidence, chainStr, insightId);
            chainsFound++;
          } catch (err) {
            log.push(`    ✗ Error: ${(err as Error).message?.slice(0, 80)}`);
          }

          if (chainsFound >= 10) break;
        }
        if (chainsFound >= 10) break;
      }
      if (chainsFound >= 10) break;
    }

    log.push(`Transitive chain scan complete: ${chainsFound} chain(s) found`);
    return { log, chainsFound };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async _analyzeForDomain(domain: string, _recentChunkId?: string): Promise<void> {
    const candidates = detectSignals(this.db, domain);
    if (candidates.length === 0) return;

    for (const candidate of candidates.slice(0, 5)) {
      await this._validateAndStore(candidate, domain);
    }
  }

  private async _analyzeForDomainWithLog(domain: string, log: string[]): Promise<number> {
    const candidates = detectSignals(this.db, domain);
    log.push(`  ${domain}: ${candidates.length} signal candidate(s) detected`);
    if (candidates.length === 0) return 0;

    let created = 0;
    for (const candidate of candidates.slice(0, 10)) {
      const signalStr = Object.entries(candidate.signals)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${(v as number).toFixed(1)}`)
        .join(', ');
      log.push(`  Evaluating: "${candidate.entityA}" ↔ "${candidate.entityB}" (score: ${candidate.compositeScore.toFixed(2)}, signals: ${signalStr})`);

      const stored = await this._validateAndStore(candidate, domain);
      if (stored) {
        log.push(`    ✓ Insight stored`);
        created++;
      } else {
        log.push(`    ✗ Rejected or below threshold`);
      }
    }
    return created;
  }

  private async _validateAndStore(candidate: SignalCandidate, domain: string): Promise<boolean> {
    const prompt = buildValidatePrompt(
      candidate.entityA,
      candidate.entityB,
      domain,
      candidate.compositeScore,
      Math.round(candidate.signals.correlation * 10),
    );

    try {
      const raw = await this.chat.chat(
        'You are an analytical assistant. Evaluate correlations between entities.',
        prompt,
      );
      const validation = parseValidation(raw);
      if (!validation?.is_valid || validation.confidence < 0.7) return false;

      // Store insight chunk
      const insightId = crypto.randomUUID();
      this.db.prepare(
        `INSERT INTO chunks (id, session_id, content, domain, entities, source_type, source_file, norm_status)
         VALUES (?, (SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1),
                 ?, ?, ?, 'insight', 'insight:correlation', 'done')`
      ).run(
        insightId,
        validation.conversational_summary,
        domain,
        JSON.stringify([candidate.entityA, candidate.entityB]),
      );

      // Store insight edge
      this._storeInsightEdge(
        candidate.entityA,
        candidate.entityB,
        validation.confidence,
        validation.causal_direction,
        insightId,
      );

      // Embed the insight
      if (this.embedding) {
        try {
          const emb = await this.embedding.embed(validation.conversational_summary, 'document');
          this.db.prepare(
            'INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)'
          ).run(insightId, Buffer.from(new Float32Array(emb).buffer));
        } catch { /* non-fatal */ }
      }

      if (this.broadcast) {
        this.broadcast({
          type: 'flow:insight',
          stage: 'complete',
          chunkId: insightId,
          entityA: candidate.entityA,
          entityB: candidate.entityB,
          confidence: validation.confidence,
        });
      }

      return true;
    } catch {
      return false;
    }
  }

  private _storeInsightEdge(
    entityA: string,
    entityB: string,
    confidence: number,
    causalDirection: string | null,
    insightChunkId: string,
  ): void {
    const existing = this.db.prepare(
      `SELECT id FROM edges WHERE source_entity = ? AND target_entity = ? AND edge_type = 'insight'`
    ).get(entityA, entityB) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE edges SET confidence = ?, causality_direction = ?, source_chunk_ids = ?,
                updated_at = datetime('now') WHERE id = ?`
      ).run(confidence, causalDirection, JSON.stringify([insightChunkId]), existing.id);
    } else {
      this.db.prepare(
        `INSERT INTO edges (id, source_entity, target_entity, edge_type, severity, confidence,
                causality_direction, source_chunk_ids, confirmation_count)
         VALUES (?, ?, ?, 'insight', 5, ?, ?, ?, 1)`
      ).run(
        crypto.randomUUID(), entityA, entityB,
        confidence, causalDirection, JSON.stringify([insightChunkId]),
      );
    }
  }
}
