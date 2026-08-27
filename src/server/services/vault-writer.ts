import fs from 'node:fs/promises';
import path from 'node:path';

export interface NoteFrontmatter {
  type: 'turn' | 'session-summary' | 'decision' | 'anomaly';
  role?: 'user' | 'assistant';
  session?: string;
  created: string;
  turn?: number;
  tags?: string[];
  parent?: string;
  domain?: string;
  source_session?: string;
  source_turns?: number[];
  [key: string]: unknown;
}

export class VaultWriter {
  constructor(private vaultPath: string) {}

  private resolvePath(relativePath: string): string {
    return path.join(this.vaultPath, relativePath);
  }

  private toYaml(frontmatter: NoteFrontmatter): string {
    const lines: string[] = ['---'];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        const items = value.map(v => String(v));
        lines.push(`${key}: [${items.join(', ')}]`);
      } else if (typeof value === 'number') {
        lines.push(`${key}: ${value}`);
      } else if (typeof value === 'string' && value.startsWith('[[')) {
        // wikilink — no quotes
        lines.push(`${key}: ${value}`);
      } else if (typeof value === 'string') {
        // quote strings
        const escaped = value.replace(/"/g, '\\"');
        lines.push(`${key}: "${escaped}"`);
      } else {
        lines.push(`${key}: ${String(value)}`);
      }
    }
    lines.push('---');
    return lines.join('\n');
  }

  async writeNote(relativePath: string, frontmatter: NoteFrontmatter, body: string): Promise<void> {
    const fullPath = this.resolvePath(relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const yaml = this.toYaml(frontmatter);
    const content = `${yaml}\n\n${body}\n`;
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  async readNote(relativePath: string): Promise<string> {
    const fullPath = this.resolvePath(relativePath);
    return fs.readFile(fullPath, 'utf-8');
  }

  async readNoteBody(relativePath: string): Promise<string> {
    const content = await this.readNote(relativePath);
    // Strip YAML frontmatter
    if (content.startsWith('---')) {
      const endIndex = content.indexOf('\n---', 3);
      if (endIndex !== -1) {
        return content.slice(endIndex + 4).trimStart();
      }
    }
    return content;
  }

  async moveDir(from: string, to: string): Promise<void> {
    const fromFull = this.resolvePath(from);
    const toFull = this.resolvePath(to);
    await fs.mkdir(path.dirname(toFull), { recursive: true });
    await fs.rename(fromFull, toFull);
  }

  async listNotes(dir: string, recursive = false): Promise<string[]> {
    const fullDir = this.resolvePath(dir);
    let entries: string[];
    try {
      entries = await fs.readdir(fullDir);
    } catch {
      return [];
    }
    const results = entries
      .filter(e => e.endsWith('.md'))
      .map(e => path.join(dir, e));

    if (recursive) {
      for (const entry of entries) {
        const entryFull = path.join(fullDir, entry);
        try {
          const stat = await fs.stat(entryFull);
          if (stat.isDirectory()) {
            const subNotes = await this.listNotes(path.join(dir, entry), true);
            results.push(...subNotes);
          }
        } catch {
          // skip
        }
      }
    }
    return results;
  }
}
