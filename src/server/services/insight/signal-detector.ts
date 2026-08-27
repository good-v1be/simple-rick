import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalScores {
  correlation: number;
  trend: number;
  anomaly: number;
}

export interface SignalCandidate {
  entityA: string;
  entityB: string;
  signals: SignalScores;
  compositeScore: number;
  sourceChunks: string[];
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const WEIGHTS = {
  correlation: 0.4,
  trend: 0.35,
  anomaly: 0.25,
} as const;

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

export function computeCompositeScore(signals: SignalScores): number {
  return (
    signals.correlation * WEIGHTS.correlation +
    signals.trend * WEIGHTS.trend +
    signals.anomaly * WEIGHTS.anomaly
  );
}

// ---------------------------------------------------------------------------
// Individual detectors (SQLite)
// ---------------------------------------------------------------------------

interface EntityPair {
  entity_a: string;
  entity_b: string;
  co_count: number;
  chunk_ids: string;
}

/**
 * Find entity pairs that co-occur in multiple chunks.
 * SQLite doesn't have LATERAL unnest, so we parse JSON entities in JS.
 */
export function detectCorrelations(
  db: Database.Database,
  domain: string,
): EntityPair[] {
  // Get all chunks with entities for this domain
  const chunks = db.prepare(
    `SELECT id, entities FROM chunks
     WHERE domain = ? AND norm_status = 'done' AND entities IS NOT NULL AND entities != '[]'`
  ).all(domain) as { id: string; entities: string }[];

  // Build co-occurrence map
  const coMap = new Map<string, { count: number; chunkIds: string[] }>();

  for (const chunk of chunks) {
    let entities: string[];
    try {
      const parsed = JSON.parse(chunk.entities);
      entities = parsed
        .map((e: unknown) => typeof e === 'string' ? e : (e as any)?.name ?? '')
        .filter((e: string) => e.length > 0 && e.length < 100);
    } catch {
      continue;
    }
    // Dedupe within chunk
    const unique = [...new Set(entities)];

    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = unique[i] < unique[j]
          ? `${unique[i]}|${unique[j]}`
          : `${unique[j]}|${unique[i]}`;
        const entry = coMap.get(key) ?? { count: 0, chunkIds: [] };
        entry.count++;
        entry.chunkIds.push(chunk.id);
        coMap.set(key, entry);
      }
    }
  }

  // Filter: need at least 2 co-occurrences
  const results: EntityPair[] = [];
  for (const [key, { count, chunkIds }] of coMap) {
    if (count >= 2) {
      const [a, b] = key.split('|');
      results.push({
        entity_a: a,
        entity_b: b,
        co_count: count,
        chunk_ids: JSON.stringify(chunkIds.slice(0, 10)),
      });
    }
  }

  results.sort((a, b) => b.co_count - a.co_count);
  return results.slice(0, 50);
}

/**
 * Detect entities with increasing severity over time.
 */
export function detectTrends(
  db: Database.Database,
  domain: string,
): Set<string> {
  // Get severity data per entity over time
  const chunks = db.prepare(
    `SELECT entities, severity, created_at FROM chunks
     WHERE domain = ? AND norm_status = 'done' AND entities IS NOT NULL AND severity IS NOT NULL
     ORDER BY created_at ASC`
  ).all(domain) as { entities: string; severity: number; created_at: string }[];

  // Track severity per entity over time
  const entitySeries = new Map<string, number[]>();
  for (const chunk of chunks) {
    let entities: string[];
    try {
      const parsed = JSON.parse(chunk.entities);
      entities = parsed.map((e: unknown) => typeof e === 'string' ? e : (e as any)?.name ?? '').filter(Boolean);
    } catch { continue; }

    for (const ent of entities) {
      const series = entitySeries.get(ent) ?? [];
      series.push(chunk.severity);
      entitySeries.set(ent, series);
    }
  }

  // Simple trend: compare mean of first half vs second half
  const trending = new Set<string>();
  for (const [entity, series] of entitySeries) {
    if (series.length < 4) continue;
    const mid = Math.floor(series.length / 2);
    const firstHalf = series.slice(0, mid);
    const secondHalf = series.slice(mid);
    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    if (avgSecond > avgFirst + 1) {
      trending.add(entity);
    }
  }

  return trending;
}

/**
 * Detect entities with abnormally high severity.
 */
export function detectAnomalies(
  db: Database.Database,
  domain: string,
): Set<string> {
  // Get domain stats
  const stats = db.prepare(
    `SELECT AVG(severity) as mean,
            AVG(severity * severity) - AVG(severity) * AVG(severity) as variance
     FROM chunks WHERE domain = ? AND norm_status = 'done' AND severity IS NOT NULL`
  ).get(domain) as { mean: number; variance: number } | undefined;

  if (!stats || stats.mean === null) return new Set();
  const stddev = Math.sqrt(Math.max(stats.variance ?? 0, 0));
  const threshold = stats.mean + 2 * Math.max(stddev, 0.5);

  // Find entities that appear in high-severity chunks
  const highChunks = db.prepare(
    `SELECT entities FROM chunks
     WHERE domain = ? AND norm_status = 'done' AND severity > ? AND entities IS NOT NULL`
  ).all(domain, threshold) as { entities: string }[];

  const anomalous = new Set<string>();
  for (const chunk of highChunks) {
    try {
      const parsed = JSON.parse(chunk.entities);
      for (const e of parsed) {
        const name = typeof e === 'string' ? e : e?.name;
        if (name) anomalous.add(name);
      }
    } catch { /* skip */ }
  }

  return anomalous;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function detectSignals(
  db: Database.Database,
  domain: string,
): SignalCandidate[] {
  const correlations = detectCorrelations(db, domain);
  const trendingEntities = detectTrends(db, domain);
  const anomalousEntities = detectAnomalies(db, domain);

  // Build signal scores for each entity pair
  const candidates: SignalCandidate[] = [];

  for (const corr of correlations) {
    const signals: SignalScores = {
      correlation: Math.min(1.0, corr.co_count / 10),
      trend: 0,
      anomaly: 0,
    };

    // Boost if either entity is trending
    if (trendingEntities.has(corr.entity_a) || trendingEntities.has(corr.entity_b)) {
      signals.trend = 0.5;
      if (trendingEntities.has(corr.entity_a) && trendingEntities.has(corr.entity_b)) {
        signals.trend = 1.0;
      }
    }

    // Boost if either entity is anomalous
    if (anomalousEntities.has(corr.entity_a) || anomalousEntities.has(corr.entity_b)) {
      signals.anomaly = 0.5;
      if (anomalousEntities.has(corr.entity_a) && anomalousEntities.has(corr.entity_b)) {
        signals.anomaly = 1.0;
      }
    }

    const compositeScore = computeCompositeScore(signals);
    if (compositeScore >= 0.3) {
      let sourceChunks: string[] = [];
      try { sourceChunks = JSON.parse(corr.chunk_ids); } catch { /* */ }

      candidates.push({
        entityA: corr.entity_a,
        entityB: corr.entity_b,
        signals,
        compositeScore,
        sourceChunks,
      });
    }
  }

  candidates.sort((a, b) => b.compositeScore - a.compositeScore);
  return candidates;
}
