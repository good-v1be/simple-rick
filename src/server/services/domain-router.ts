import { extractObject, asString, asStringArray, asEnum } from './ai-json.js';
import type { ChatProvider } from './ai-providers.js';
import type { VaultWriter } from './vault-writer.js';
import type { NoteEmbedder } from './note-embedder.js';

const VALID_DOMAINS = [
  'Code', 'Architecture', 'Testing', 'DevOps', 'Data', 'Frontend',
  'Backend', 'Documentation', 'Security', 'Performance', 'Research', 'Miscellaneous',
] as const;

export interface RouteResult {
  domain: string;
  summary: string;
  tags: string[];
  anomalies: Array<{ turns: number[]; domain: string; topic: string }>;
}

export class DomainRouter {
  constructor(
    private chat: ChatProvider | null,
    private vaultWriter: VaultWriter,
    private noteEmbedder: NoteEmbedder,
  ) {}

  async classifySession(sessionId: string, turnContents: string[]): Promise<RouteResult> {
    if (!this.chat) {
      return { domain: 'Miscellaneous', summary: '', tags: [], anomalies: [] };
    }

    const turnsText = turnContents
      .map((t, i) => `[Turn ${i + 1}] ${t}`)
      .join('\n\n');

    const system = `You are a session classifier. Analyze conversation turns and return a JSON object.

Respond ONLY with a valid JSON object (no markdown, no code fences) in this exact shape:
{
  "domain": "<one of the domains below>",
  "summary": "<3 sentence summary of the session>",
  "tags": ["tag1", "tag2", "tag3"],
  "anomalies": []
}

Valid domains:
- Code: Implementation, debugging, code changes
- Architecture: Design decisions, tech stack, infrastructure
- Testing: Tests, QA, validation
- DevOps: Docker, deployment, CI/CD, monitoring
- Data: Database, migrations, queries, schemas
- Frontend: UI, components, styling, UX
- Backend: API, services, server logic
- Documentation: Docs, README, comments
- Security: Auth, permissions, vulnerabilities
- Performance: Optimization, caching, benchmarks
- Research: Exploration, spikes, investigation
- Miscellaneous: Everything else

Pick the MOST SPECIFIC domain that fits the session's primary focus.

Rules:
1. Generate 3-5 relevant tags (lowercase, no spaces, use hyphens)
2. Write a 3-sentence summary describing what was discussed and decided
3. anomalies is always an empty array (simplified routing)`;

    const raw = await this.chat.chat(system, `Session ID: ${sessionId}\n\nTurns:\n${turnsText}`);

    const parsed = extractObject(raw, 'domain-router');
    return {
      domain: asEnum(parsed['domain'], VALID_DOMAINS, 'Miscellaneous', 'domain-router', 'domain'),
      summary: asString(parsed['summary'], raw.trim(), 'domain-router', 'summary'),
      tags: asStringArray(parsed['tags'], 'domain-router', 'tags', 5),
      anomalies: [],
    };
  }

  async routeSession(
    sessionId: string,
    sessionSlug: string,
    route: RouteResult,
  ): Promise<void> {
    const fromDir = `Inbox/${sessionSlug}`;
    const toDir = `${route.domain}/${sessionSlug}`;

    // Move session directory from Inbox to domain folder
    await this.vaultWriter.moveDir(fromDir, toDir);

    // Update embeddings paths for moved notes
    const notes = await this.vaultWriter.listNotes(toDir, true);
    for (const notePath of notes) {
      const oldPath = notePath.replace(toDir, fromDir);
      await this.noteEmbedder.updatePath(oldPath, notePath);
    }
  }
}
