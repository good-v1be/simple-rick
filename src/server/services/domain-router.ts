import type { ChatProvider } from './ai-providers.js';
import type { VaultWriter } from './vault-writer.js';
import type { NoteEmbedder } from './note-embedder.js';

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

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('[domain-router] Failed to extract JSON from AI response:', raw.slice(0, 200));
      return { domain: 'Miscellaneous', summary: raw.trim(), tags: [], anomalies: [] };
    }

    try {
      const parsed = JSON.parse(match[0]) as RouteResult;
      const validDomains = [
        'Code', 'Architecture', 'Testing', 'DevOps', 'Data', 'Frontend',
        'Backend', 'Documentation', 'Security', 'Performance', 'Research', 'Miscellaneous',
      ];
      const domain = validDomains.includes(parsed.domain) ? parsed.domain : 'Miscellaneous';
      return {
        domain,
        summary: parsed.summary ?? '',
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        anomalies: [],
      };
    } catch (err) {
      console.error('[domain-router] JSON parse failed:', err);
      return { domain: 'Miscellaneous', summary: '', tags: [], anomalies: [] };
    }
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
