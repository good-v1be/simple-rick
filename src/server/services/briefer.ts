import type Database from 'better-sqlite3';
import type { VaultWriter } from './vault-writer.js';
import type { NoteEmbedder } from './note-embedder.js';

export class Briefer {
  constructor(
    private db: Database.Database,
    private vaultWriter: VaultWriter,
    private noteEmbedder: NoteEmbedder,
  ) {}

  async generateBriefing(sessionId: string, focus?: string): Promise<string> {
    const parts: string[] = [];

    // ── 1. Recent closed sessions ─────────────────────────────────────────────
    const lastSessions = this.db.prepare(
      "SELECT id, closed_at, summary, domain FROM sessions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 5"
    ).all() as Array<{ id: string; closed_at: string; summary: string | null; domain: string | null }>;

    if (lastSessions.length > 0) {
      parts.push('## Recent Sessions');
      for (const s of lastSessions) {
        const domain = s.domain ?? 'Inbox';
        const ago = this.timeAgo(new Date(s.closed_at));
        const summary = s.summary ? s.summary.slice(0, 120) : '(no summary)';
        parts.push(`- **${domain}** — ${ago}\n  ${summary}`);
      }
    } else {
      parts.push('## Recent Sessions\nNo closed sessions yet.');
    }

    // ── 2. Focus semantic search ──────────────────────────────────────────────
    if (focus) {
      const results = await this.search(focus, undefined, 5);
      if (results) {
        parts.push(`\n## Focus: "${focus}"\n${results}`);
      }
    }

    return parts.join('\n\n');
  }

  async search(query: string, intentFilter?: string, limit = 10): Promise<string> {
    const results = await this.noteEmbedder.search(query, limit);
    if (results.length === 0) return 'No results found.';

    const lines: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      let body = '';
      try {
        body = await this.vaultWriter.readNoteBody(r.note_path);
      } catch {
        body = '(could not read note)';
      }
      const preview = body.slice(0, 200).replace(/\n+/g, ' ');
      lines.push(`${i + 1}. **${r.note_path}** (${Math.round(r.score * 100)}%)\n   ${preview}`);
    }

    return lines.join('\n\n');
  }

  async ask(question: string): Promise<string> {
    const results = await this.noteEmbedder.search(question, 10);
    if (results.length === 0) return 'No relevant notes found in history.';

    const lines: string[] = [`## Relevant Context\n`];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      let body = '';
      try {
        body = await this.vaultWriter.readNoteBody(r.note_path);
      } catch {
        body = '(could not read note)';
      }
      const preview = body.slice(0, 300).replace(/\n+/g, ' ');
      lines.push(`[${i + 1}] **${r.note_path}**\n${preview}`);
    }
    lines.push(`\n---\n*${results.length} notes found.*`);
    return lines.join('\n\n');
  }

  private timeAgo(date: Date): string {
    const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hours ago`;
    return `${Math.floor(hours / 24)} days ago`;
  }
}
