import type Database from 'better-sqlite3';
import type { LightweightNormalizer } from './lightweight-normalizer.js';
import type { DeepNormalizer } from './deep-normalizer.js';
import type { EdgeWirer } from './edge-wirer.js';
import type { InsightEngine } from './insight/engine.js';
import { LIMITS } from '../limits.js';

type EventCallback = (event: Record<string, unknown>) => void;

export class NormQueue {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private insightEngine: InsightEngine | null = null;

  constructor(
    private db: Database.Database,
    private lightNorm: LightweightNormalizer,
    private deepNorm: DeepNormalizer,
    private edgeWirer: EdgeWirer,
    private onEvent: EventCallback,
    private throttleMs = LIMITS.queueThrottleMs,
  ) {}

  /** Wire up the insight engine for post-normalization analysis. */
  setInsightEngine(engine: InsightEngine): void {
    this.insightEngine = engine;
  }

  start(): void {
    // Recovery: reset stuck + skipped items from previous runs
    this.db.prepare("UPDATE norm_queue SET status = 'pending' WHERE status IN ('processing', 'skipped')").run();
    this.running = true;
    this._scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async drain(maxItems = 3): Promise<number> {
    let processed = 0;
    while (processed < maxItems) {
      const item = this._dequeue();
      if (!item) break;
      await this._processItem(item);
      processed++;
    }
    this.db.prepare("UPDATE norm_queue SET status = 'skipped' WHERE status = 'pending'").run();
    return processed;
  }

  pendingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM norm_queue WHERE status = 'pending'").get() as { cnt: number };
    return row.cnt;
  }

  getStatus(): { pending: number; processing: number; done: number } {
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) as cnt FROM norm_queue GROUP BY status"
    ).all() as Array<{ status: string; cnt: number }>;
    const m: Record<string, number> = {};
    for (const r of rows) m[r.status] = r.cnt;
    return { pending: m['pending'] ?? 0, processing: m['processing'] ?? 0, done: m['done'] ?? 0 };
  }

  private _scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      const item = this._dequeue();
      if (item) await this._processItem(item);
      this._scheduleNext();
    }, this.throttleMs);
  }

  private _dequeue(): { id: number; chunk_id: string } | null {
    const item = this.db.prepare(
      "SELECT id, chunk_id FROM norm_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 1"
    ).get() as { id: number; chunk_id: string } | undefined;
    if (!item) return null;
    this.db.prepare("UPDATE norm_queue SET status = 'processing' WHERE id = ?").run(item.id);
    return item;
  }

  private async _processItem(item: { id: number; chunk_id: string }): Promise<void> {
    try {
      // Step 1: Lightweight normalization (entities, domain, severity)
      await this.lightNorm.extract(item.chunk_id);
      // Step 2: Deep normalization (normalized_text, affected, causality, embedding)
      await this.deepNorm.normalize(item.chunk_id);
      // Step 3: Wire edges from extracted data
      const { newEdges } = this.edgeWirer.wireFromChunk(item.chunk_id);
      this.db.prepare("UPDATE norm_queue SET status = 'done' WHERE id = ?").run(item.id);

      const chunk = this.db.prepare(
        'SELECT id, normalized_text, domain, entities, severity FROM chunks WHERE id = ?'
      ).get(item.chunk_id) as Record<string, unknown>;

      this.onEvent({
        type: 'chunk:normalized',
        chunk_id: item.chunk_id,
        chunk,
        edges: newEdges,
      });

      // Trigger insight analysis (fire-and-forget)
      if (this.insightEngine) {
        this.insightEngine.analyzeAfterNormalization(item.chunk_id).catch(err => {
          console.error(`[norm-queue] Insight analysis failed:`, err);
        });
      }
    } catch (err) {
      this.db.prepare("UPDATE norm_queue SET status = 'failed' WHERE id = ?").run(item.id);
      console.error(`[norm-queue] Failed chunk ${item.chunk_id}:`, err);
    }
  }
}
