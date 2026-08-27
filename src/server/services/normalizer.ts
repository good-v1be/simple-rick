import type Database from 'better-sqlite3';
import type { VaultWriter, NoteFrontmatter } from './vault-writer.js';
import type { NoteEmbedder } from './note-embedder.js';
import type { DomainRouter } from './domain-router.js';
import type { Recorder } from './recorder.js';
import type { NormQueue } from './norm-queue.js';
import { logWarn } from '../log.js';

export class Normalizer {
  constructor(
    private db: Database.Database,
    private vaultWriter: VaultWriter,
    private noteEmbedder: NoteEmbedder,
    private domainRouter: DomainRouter,
    private recorder: Recorder,
    private normQueue: NormQueue,
  ) {}

  async closeSession(sessionId: string): Promise<string> {
    const sessionSlug = this.recorder.getSlug(sessionId);

    // Drain norm-queue before closing (process up to 3 pending items)
    const drained = await this.normQueue.drain(3);
    if (drained > 0) {
      console.error(`[normalizer] Drained ${drained} norm-queue items before close`);
    }

    // List all note files from the Inbox folder (including decisions/, links/ subdirs)
    const turnFiles = await this.vaultWriter.listNotes(`Inbox/${sessionSlug}`, true);
    turnFiles.sort();

    if (turnFiles.length === 0) {
      return 'Session had no turn files — nothing to normalize.';
    }

    // Read each turn's body and role from vault
    const turnContents: string[] = [];
    for (const filePath of turnFiles) {
      try {
        const body = await this.vaultWriter.readNoteBody(filePath);
        turnContents.push(body);
      } catch {
        turnContents.push('');
      }
    }

    // Classify the session
    const route = await this.domainRouter.classifySession(sessionId, turnContents);

    // Route session (move files from Inbox to domain folder)
    await this.domainRouter.routeSession(sessionId, sessionSlug, route);

    // Write session-summary.md in target domain folder
    const summaryPath = `${route.domain}/${sessionSlug}/session-summary.md`;
    const now = new Date().toISOString();

    const frontmatter: NoteFrontmatter = {
      type: 'session-summary',
      session: sessionId,
      created: now,
      domain: route.domain,
      tags: route.tags,
    };

    const summaryLines = [
      `# Session Summary`,
      '',
      route.summary,
      '',
      `**Domain:** ${route.domain}`,
      `**Tags:** ${route.tags.join(', ')}`,
      `**Turns:** ${turnFiles.length}`,
    ];

    if (route.anomalies.length > 0) {
      summaryLines.push('', '## Anomalies');
      for (const a of route.anomalies) {
        summaryLines.push(`- Turns ${a.turns.join(', ')}: ${a.topic} → [[${a.domain}]]`);
      }
    }

    await this.vaultWriter.writeNote(summaryPath, frontmatter, summaryLines.join('\n'));

    // Embed the summary
    await this.noteEmbedder.embedNote(summaryPath, route.summary);

    // Update sessions table with domain and tags
    try {
      this.db.prepare(
        "UPDATE sessions SET domain = ?, tags = ?, summary = ?, status = 'closed', closed_at = datetime('now') WHERE id = ?"
      ).run(route.domain, JSON.stringify(route.tags), route.summary, sessionId);
    } catch (err) {
      // Unexpected: the sessions table should always have these columns.
      logWarn('normalizer', `could not persist route for session ${sessionId}`, err);
    }

    // Clear recorder turn counter for this session
    this.recorder.clearSession(sessionId);

    return [
      `## Session Closed`,
      `**Slug:** ${sessionSlug}`,
      `**Domain:** ${route.domain}`,
      `**Turns processed:** ${turnFiles.length}`,
      `**Tags:** ${route.tags.join(', ')}`,
      '',
      route.summary,
    ].join('\n');
  }
}
