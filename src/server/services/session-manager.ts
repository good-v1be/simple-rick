import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export class SessionManager {
  constructor(private db: Database.Database) {}

  ensureSession(): string {
    const row = this.db.prepare(
      "SELECT id FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1"
    ).get() as { id: string } | undefined;
    if (row) return row.id;
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id);
    return id;
  }

  closeSession(sessionId: string, summary: string): void {
    this.db.prepare(
      "UPDATE sessions SET closed_at = datetime('now'), summary = ?, status = 'closed' WHERE id = ?"
    ).run(summary, sessionId);
  }
}
