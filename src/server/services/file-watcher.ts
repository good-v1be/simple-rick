import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPatch } from 'diff';
import type Database from 'better-sqlite3';

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private fileCache = new Map<string, string>(); // last known content
  private sessionResolver: (() => Promise<string>) | null = null;

  constructor(
    private db: Database.Database,
    private projectPath: string,
  ) {}

  /** Set session ID resolver (called lazily to get current session) */
  setSessionResolver(resolver: () => Promise<string>): void {
    this.sessionResolver = resolver;
  }

  start(): void {
    this.watcher = chokidar.watch(this.projectPath, {
      ignored: [
        /(^|[/\\])\./,         // dotfiles
        /node_modules/,
        /dist\//,
        /\.git\//,
        /package-lock\.json/,
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    this.watcher.on('change', (filePath: string) => this.handleChange(filePath));
    this.watcher.on('add', (filePath: string) => this.handleChange(filePath));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private async handleChange(absolutePath: string): Promise<void> {
    if (!this.sessionResolver) return;

    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      const relativePath = path.relative(this.projectPath, absolutePath);
      const previousContent = this.fileCache.get(relativePath);

      // Compute diff
      let diff: string | undefined;
      if (previousContent != null) {
        diff = createPatch(relativePath, previousContent, content, '', '', { context: 3 });
      }

      this.fileCache.set(relativePath, content);

      // Save to DB
      const sessionId = await this.sessionResolver();
      const timestampMs = Date.now();
      this.db.prepare(
        'INSERT INTO file_states (session_id, timestamp_ms, file_path, content, diff) VALUES (?, ?, ?, ?, ?)'
      ).run(sessionId, timestampMs, relativePath, content, diff ?? null);
    } catch {
      // File might be binary or inaccessible — skip silently
    }
  }
}
