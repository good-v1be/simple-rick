import type Database from 'better-sqlite3';
import type { ChatProvider } from './ai-providers.js';

const VALID_DOMAINS = [
  'Code',           // Implementation, debugging, code changes
  'Architecture',   // Design decisions, tech stack, infrastructure
  'Testing',        // Tests, QA, validation
  'DevOps',         // Docker, deployment, CI/CD, monitoring
  'Data',           // Database, migrations, queries, schemas
  'Frontend',       // UI, components, styling, UX
  'Backend',        // API, services, server logic
  'Documentation',  // Docs, README, comments
  'Security',       // Auth, permissions, vulnerabilities
  'Performance',    // Optimization, caching, benchmarks
  'Research',       // Exploration, spikes, investigation
  'Miscellaneous',  // Everything else
] as const;

const DOMAIN_LIST = VALID_DOMAINS.join(', ');

export class LightweightNormalizer {
  constructor(private db: Database.Database, private chat: ChatProvider) {}

  async extract(chunkId: string): Promise<{ entities: string[]; domain: string; severity: number }> {
    const chunk = this.db.prepare('SELECT content FROM chunks WHERE id = ?').get(chunkId) as { content: string };

    const result = await this.chat.chat(
      `Extract from this development session turn:
- entities: key concepts, components, files, tools mentioned (JSON string array, 3-10 items)
- domain: classify into exactly ONE of: ${DOMAIN_LIST}
- severity: importance 1-10 (1=trivial, 5=normal, 10=critical)
Return ONLY JSON: {"entities":[],"domain":"","severity":5}`,
      chunk.content
    );

    const parsed = JSON.parse(result.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    const entities = parsed.entities ?? [];
    const rawDomain = String(parsed.domain ?? 'Miscellaneous');
    const domain = (VALID_DOMAINS as readonly string[]).includes(rawDomain) ? rawDomain : 'Miscellaneous';
    const severity = Math.min(10, Math.max(1, parsed.severity ?? 5));

    this.db.prepare(
      'UPDATE chunks SET entities = ?, domain = ?, severity = ? WHERE id = ?'
    ).run(JSON.stringify(entities), domain, severity, chunkId);

    return { entities, domain, severity };
  }
}
