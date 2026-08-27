import type Database from 'better-sqlite3';
import type { VaultWriter, NoteFrontmatter } from './vault-writer.js';
import type { NoteEmbedder } from './note-embedder.js';
import crypto from 'node:crypto';

export class Recorder {
  private turnCounters = new Map<string, number>();

  constructor(
    private db: Database.Database,
    private vaultWriter: VaultWriter,
    private noteEmbedder: NoteEmbedder,
  ) {}

  getSlug(sessionId: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return `${date}-${sessionId.slice(0, 8)}`;
  }

  getTurnCount(sessionId: string): number {
    return this.turnCounters.get(sessionId) ?? 0;
  }

  clearSession(sessionId: string): void {
    this.turnCounters.delete(sessionId);
  }

  private nextTurn(sessionId: string): number {
    // Check in-memory first, fall back to DB for cross-process continuity
    let current = this.turnCounters.get(sessionId);
    if (current === undefined) {
      const row = this.db.prepare(
        'SELECT MAX(turn_num) as max_turn FROM turns WHERE session_id = ?'
      ).get(sessionId) as { max_turn: number | null } | undefined;
      current = row?.max_turn ?? 0;
    }
    const n = current + 1;
    this.turnCounters.set(sessionId, n);
    return n;
  }

  private padTurn(n: number): string {
    return String(n).padStart(3, '0');
  }

  async recordMessage(
    sessionId: string,
    role: 'user' | 'ai' | 'tool_call' | 'tool_result',
    content: string,
    toolName?: string,
    toolInput?: string,
  ): Promise<{ turnId: string; chunkId: string }> {
    const slug = this.getSlug(sessionId);
    const turn = this.nextTurn(sessionId);
    const relativePath = `Inbox/${slug}/turn-${this.padTurn(turn)}.md`;
    const now = new Date().toISOString();

    const prevTurn = turn > 1 ? `[[Inbox/${slug}/turn-${this.padTurn(turn - 1)}]]` : undefined;

    const frontmatter: NoteFrontmatter = {
      type: 'turn',
      role: role === 'ai' ? 'assistant' : role === 'user' ? 'user' : undefined,
      session: sessionId,
      created: now,
      turn,
      tags: [role, `session-${slug}`],
      parent: prevTurn,
    };

    let body = content;
    if (toolName) body += `\n\n**Tool:** \`${toolName}\``;
    if (toolInput) body += `\n\n**Input:**\n\`\`\`json\n${toolInput}\n\`\`\``;

    // 1. Write vault MD file
    await this.vaultWriter.writeNote(relativePath, frontmatter, body);

    // Only embed user and ai roles
    if (role === 'user' || role === 'ai') {
      await this.noteEmbedder.embedNote(relativePath, content);
    }

    // 2. INSERT into turns
    const turnId = crypto.randomUUID();
    this.db.prepare(
      'INSERT INTO turns (id, session_id, turn_num, role, content, timestamp_ms) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(turnId, sessionId, turn, role, content, Date.now());

    // 3. INSERT into chunks
    const chunkId = crypto.randomUUID();
    this.db.prepare(
      "INSERT INTO chunks (id, session_id, turn_id, content, source_file, norm_status) VALUES (?, ?, ?, ?, ?, 'pending')"
    ).run(chunkId, sessionId, turnId, content, relativePath);

    // 4. INSERT into norm_queue
    this.db.prepare(
      "INSERT INTO norm_queue (chunk_id, status) VALUES (?, 'pending')"
    ).run(chunkId);

    return { turnId, chunkId };
  }

  async recordDecision(
    sessionId: string,
    decision: string,
    rationale: string,
    component?: string,
    alternatives?: string[],
  ): Promise<string> {
    const slug = this.getSlug(sessionId);
    const decisionSlug = decision
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 60);
    const relativePath = `Inbox/${slug}/decisions/${decisionSlug}.md`;
    const now = new Date().toISOString();
    const turn = this.nextTurn(sessionId);
    const prevTurn = turn > 1 ? `[[Inbox/${slug}/turn-${this.padTurn(turn - 1)}]]` : undefined;

    const frontmatter: NoteFrontmatter = {
      type: 'decision',
      session: sessionId,
      created: now,
      turn,
      tags: ['decision', component ?? 'unknown'],
      parent: prevTurn,
    };

    const lines = [
      `# Decision: ${decision}`,
      '',
      `## Rationale`,
      rationale,
    ];
    if (component) lines.push('', `**Component:** ${component}`);
    if (alternatives?.length) {
      lines.push('', `## Alternatives Rejected`);
      for (const alt of alternatives) lines.push(`- ${alt}`);
    }

    const body = lines.join('\n');
    await this.vaultWriter.writeNote(relativePath, frontmatter, body);
    await this.noteEmbedder.embedNote(relativePath, `Decision: ${decision}. Rationale: ${rationale}.`);

    // Also record as a turn in DB for session tracking
    const turnId = crypto.randomUUID();
    const content = `Decision: ${decision}. Rationale: ${rationale}.`;
    this.db.prepare(
      'INSERT INTO turns (id, session_id, turn_num, role, content, timestamp_ms) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(turnId, sessionId, turn, 'tool_call', content, Date.now());

    // Create chunk linked to vault file
    const chunkId = crypto.randomUUID();
    const entities = [decision, component].filter(Boolean);
    this.db.prepare(
      "INSERT INTO chunks (id, session_id, turn_id, content, entities, domain, source_file, norm_status) VALUES (?, ?, ?, ?, ?, 'Code', ?, 'pending')"
    ).run(chunkId, sessionId, turnId, content, JSON.stringify(entities), relativePath);

    this.db.prepare(
      "INSERT INTO norm_queue (chunk_id, status) VALUES (?, 'pending')"
    ).run(chunkId);

    return relativePath;
  }

  async recordLink(
    sessionId: string,
    from: string,
    to: string,
    relation: string,
  ): Promise<void> {
    const slug = this.getSlug(sessionId);
    const linkSlug = `${from}-${relation}-${to}`
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 80);
    const relativePath = `Inbox/${slug}/links/${linkSlug}.md`;
    const now = new Date().toISOString();
    const turn = this.nextTurn(sessionId);
    const prevTurn = turn > 1 ? `[[Inbox/${slug}/turn-${this.padTurn(turn - 1)}]]` : undefined;

    const frontmatter: NoteFrontmatter = {
      type: 'turn',
      session: sessionId,
      created: now,
      turn,
      tags: ['link'],
      parent: prevTurn,
    };

    const body = `# Link\n\n- **From:** ${from}\n- **Relation:** ${relation}\n- **To:** ${to}\n`;
    await this.vaultWriter.writeNote(relativePath, frontmatter, body);

    // Record as turn in DB
    const turnId = crypto.randomUUID();
    const content = `Link: ${from} —[${relation}]→ ${to}`;
    this.db.prepare(
      'INSERT INTO turns (id, session_id, turn_num, role, content, timestamp_ms) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(turnId, sessionId, turn, 'tool_call', content, Date.now());

    // Persist edge in DB
    const existing = this.db.prepare(
      'SELECT id, confirmation_count FROM edges WHERE source_entity = ? AND target_entity = ? AND edge_type = ?'
    ).get(from, to, relation) as { id: string; confirmation_count: number } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE edges SET confirmation_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(existing.confirmation_count + 1, existing.id);
    } else {
      this.db.prepare(
        'INSERT INTO edges (id, source_entity, target_entity, edge_type, severity, causality_direction, source_chunk_ids, confirmation_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(crypto.randomUUID(), from, to, relation, 5, `${from} → ${to}`, '[]', 1);
    }
  }
}
