import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
import type { EmbeddingProvider, ChatProvider } from './ai-providers.js';
import { extractArray, asStringArray, filterValid } from './ai-json.js';
import { logDebug, logWarn } from '../log.js';
import { LIMITS } from '../limits.js';

interface ScannedFile {
  relativePath: string;
  content: string;
  sizeBytes: number;
}

const KEY_FILES = [
  'CLAUDE.md', 'README.md', 'package.json', 'tsconfig.json',
  'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
  '.env.example', 'vite.config.ts', 'vite.config.js',
  'tailwind.config.ts', 'tailwind.config.js',
];

const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
  '.py', '.go', '.rs', '.rb', '.java', '.kt',
  '.sql', '.graphql', '.prisma',
  '.md', '.json', '.yaml', '.yml', '.toml',
  '.css', '.scss', '.html',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '.turbo', 'vendor', '__pycache__',
]);

const MAX_FILE_SIZE = LIMITS.maxFileSize;
const MAX_FILES = LIMITS.maxFiles;

export class CodebaseScanner {
  constructor(
    private db: Database.Database,
    private chat: ChatProvider | null,
    private embedding: EmbeddingProvider | null,
  ) {}

  async scanAndStore(
    sessionId: string,
    projectPath: string,
    projectName: string,
  ): Promise<string> {
    // 1. Collect file tree
    const allFiles = await this.collectFiles(projectPath);
    const tree = this.buildTreeString(allFiles.map(f => f.relativePath));

    // 2. Read key files
    const keyFiles = await this.readKeyFiles(projectPath);

    // 3. Read source files (first N lines for large files)
    const sourceFiles = await this.readSourceFiles(projectPath, allFiles);

    // 4. Store file tree as chunk
    await this.storeChunk(sessionId, {
      summary: `Project structure of "${projectName}": ${allFiles.length} files.\n\n${tree}`,
      intent: 'architecture_decision',
      component: 'project/structure',
    });

    // 5. Store key files as individual chunks
    for (const kf of keyFiles) {
      await this.storeChunk(sessionId, {
        summary: `Key file ${kf.relativePath}:\n\n${kf.content}`,
        intent: 'config',
        component: `project/${kf.relativePath}`,
        filesAffected: [kf.relativePath],
      });
    }

    // 6. Generate architecture summary via AI
    let archSummary = '';
    if (this.chat && keyFiles.length > 0) {
      archSummary = await this.generateArchSummary(projectName, tree, keyFiles, sourceFiles);
      if (archSummary) {
        await this.storeChunk(sessionId, {
          summary: archSummary,
          intent: 'architecture_decision',
          component: 'project/architecture',
        });
      }
    }

    // 7. Store source file snapshots in file_states
    for (const sf of sourceFiles) {
      const timestampMs = Date.now();
      this.db.prepare(
        'INSERT INTO file_states (session_id, timestamp_ms, file_path, content) VALUES (?, ?, ?, ?)'
      ).run(sessionId, timestampMs, sf.relativePath, sf.content);
    }

    // 8. Extract TODO/FIXME markers from source
    const todos = this.extractTodos(sourceFiles);
    if (todos.length > 0) {
      await this.storeChunk(sessionId, {
        summary: `Offene TODOs/FIXMEs im Code (${todos.length}):\n\n${todos.map(t => `- **${t.file}:${t.line}** ${t.marker}: ${t.text}`).join('\n')}`,
        intent: 'bugfix',
        component: 'project/todos',
        filesAffected: [...new Set(todos.map(t => t.file))],
      });
    }

    // 9. AI: Extract architecture decisions from code patterns
    let decisionsCount = 0;
    if (this.chat && sourceFiles.length > 0) {
      decisionsCount = await this.extractDecisions(sessionId, projectName, keyFiles, sourceFiles);
    }

    // 10. AI: Extract patterns and conventions
    let patternsExtracted = false;
    if (this.chat && sourceFiles.length > 0) {
      patternsExtracted = await this.extractPatterns(sessionId, projectName, sourceFiles);
    }

    // 11. Git history analysis
    let gitLearnings = 0;
    try {
      gitLearnings = await this.analyzeGitHistory(sessionId, projectPath, projectName);
    } catch (err) {
      // Expected outside a git repo.
      logDebug('scanner', 'git history analysis skipped', err);
    }

    return [
      `## Codebase Scan Complete`,
      `- **${allFiles.length}** files found`,
      `- **${keyFiles.length}** key files indexed`,
      `- **${sourceFiles.length}** source files stored as snapshots`,
      archSummary ? `- Architecture analysis created` : `- No AI provider available for architecture analysis`,
      todos.length > 0 ? `- **${todos.length}** TODOs/FIXMEs found` : null,
      decisionsCount > 0 ? `- **${decisionsCount}** architecture decisions extracted` : null,
      patternsExtracted ? `- Code patterns and conventions analyzed` : null,
      gitLearnings > 0 ? `- **${gitLearnings}** learnings extracted from git history` : null,
    ].filter(Boolean).join('\n');
  }

  private async collectFiles(dir: string, base = dir): Promise<Array<{ relativePath: string }>> {
    const results: Array<{ relativePath: string }> = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this.collectFiles(full, base);
        results.push(...sub);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (SCAN_EXTENSIONS.has(ext) || KEY_FILES.includes(entry.name)) {
          results.push({ relativePath: path.relative(base, full) });
        }
      }
      if (results.length >= MAX_FILES) break;
    }
    return results;
  }

  private async readKeyFiles(projectPath: string): Promise<ScannedFile[]> {
    const results: ScannedFile[] = [];
    for (const name of KEY_FILES) {
      const full = path.join(projectPath, name);
      try {
        const content = await fs.readFile(full, 'utf-8');
        if (content.length <= MAX_FILE_SIZE) {
          results.push({ relativePath: name, content, sizeBytes: content.length });
        }
      } catch (err) {
        logDebug('scanner', `key file ${name} not readable`, err);
      }
    }
    return results;
  }

  private async readSourceFiles(
    projectPath: string,
    allFiles: Array<{ relativePath: string }>,
  ): Promise<ScannedFile[]> {
    const results: ScannedFile[] = [];
    const sourceOnly = allFiles.filter(f => {
      const ext = path.extname(f.relativePath).toLowerCase();
      return ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.vue', '.svelte'].includes(ext);
    });

    for (const file of sourceOnly.slice(0, 200)) {
      try {
        const full = path.join(projectPath, file.relativePath);
        const content = await fs.readFile(full, 'utf-8');
        if (content.length <= MAX_FILE_SIZE) {
          results.push({ relativePath: file.relativePath, content, sizeBytes: content.length });
        }
      } catch (err) {
        logDebug('scanner', `source file ${file.relativePath} not readable`, err);
      }
    }
    return results;
  }

  private buildTreeString(paths: string[]): string {
    const sorted = [...paths].sort();
    const lines: string[] = [];
    let lastDir = '';

    for (const p of sorted) {
      const dir = path.dirname(p);
      if (dir !== lastDir) {
        lines.push(`${dir}/`);
        lastDir = dir;
      }
      lines.push(`  ${path.basename(p)}`);
    }
    return lines.join('\n');
  }

  private async storeChunk(
    sessionId: string,
    opts: {
      summary: string; intent: string; component: string;
      filesAffected?: string[]; decision?: string; decisionRationale?: string;
    },
  ): Promise<void> {
    const emb = this.embedding
      ? await this.embedding.embed(opts.summary.slice(0, 4000), 'document')
      : null;

    // Extract entities from the summary content
    let entities: string[] = [];
    if (opts.filesAffected?.length) {
      entities.push(...opts.filesAffected);
    }
    // Extract key terms from component path
    if (opts.component) {
      entities.push(opts.component.split('/').pop()!);
    }
    // Extract from decision if present
    if (opts.decision) {
      entities.push(opts.decision);
    }

    const chunkId = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO chunks (id, session_id, content, normalized_text, domain, entities, source_type, source_file, norm_status)
       VALUES (?, ?, ?, ?, 'Code', ?, ?, ?, 'done')`
    ).run(
      chunkId, sessionId, opts.summary, opts.summary,
      JSON.stringify(entities),
      opts.intent,
      // source_file: use component as a logical identifier (prefixed to distinguish from vault paths)
      `scan:${opts.component}`,
    );

    if (emb) {
      this.db.prepare(
        'INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)'
      ).run(chunkId, Buffer.from(new Float32Array(emb).buffer));
    }
  }

  private extractTodos(sourceFiles: ScannedFile[]): Array<{ file: string; line: number; marker: string; text: string }> {
    const results: Array<{ file: string; line: number; marker: string; text: string }> = [];
    const pattern = /\b(TODO|FIXME|HACK|XXX|BUG)\b[:\s]*(.*)/i;

    for (const file of sourceFiles) {
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(pattern);
        if (match) {
          results.push({
            file: file.relativePath,
            line: i + 1,
            marker: match[1].toUpperCase(),
            text: match[2].trim().slice(0, 200),
          });
        }
      }
    }
    return results;
  }

  private async extractDecisions(
    sessionId: string,
    projectName: string,
    keyFiles: ScannedFile[],
    sourceFiles: ScannedFile[],
  ): Promise<number> {
    const packageJson = keyFiles.find(f => f.relativePath === 'package.json');
    const dockerFile = keyFiles.find(f => f.relativePath === 'Dockerfile');
    const claudeMd = keyFiles.find(f => f.relativePath === 'CLAUDE.md');

    // Sample imports and patterns from source files
    const importSample = sourceFiles.slice(0, 30)
      .flatMap(f => f.content.split('\n').filter(l => /^import\s/.test(l)))
      .slice(0, 100)
      .join('\n');

    const prompt = `Analyze this project and extract implicit architecture decisions.

Project: ${projectName}

${packageJson ? `### package.json\n${packageJson.content.slice(0, 2000)}` : ''}
${dockerFile ? `### Dockerfile\n${dockerFile.content.slice(0, 1000)}` : ''}
${claudeMd ? `### CLAUDE.md\n${claudeMd.content.slice(0, 2000)}` : ''}

### Import patterns
${importSample.slice(0, 2000)}

Extract the 5-8 MOST IMPORTANT architecture decisions (only the genuinely significant ones, not every single library). For each:
- What was chosen and why (as far as it can be inferred from the code)
- Which alternatives were implicitly rejected

Respond with JSON ONLY (no code fences):
[{"decision": "...", "rationale": "...", "component": "...", "alternatives": ["..."]}]`;

    try {
      const raw = await this.chat!.chat(
        'You are a software architect. Extract implicit decisions from code.',
        prompt,
      );
      const decisions = filterValid(
        extractArray(raw, 'scanner'),
        (item): item is { decision: string; rationale: string; component?: string; alternatives?: string[] } =>
          typeof item === 'object' && item !== null &&
          typeof (item as { decision?: unknown }).decision === 'string' &&
          typeof (item as { rationale?: unknown }).rationale === 'string',
        'scanner',
        'decisions',
      );

      for (const d of decisions) {
        const alternatives = asStringArray(d.alternatives, 'scanner', 'alternatives');
        const altText = alternatives.length ? ` Rejected alternatives: ${alternatives.join(', ')}.` : '';
        await this.storeChunk(sessionId, {
          summary: `${d.decision}. ${d.rationale}.${altText}`,
          intent: 'architecture_decision',
          component: d.component ?? 'project',
          decision: d.decision,
          decisionRationale: d.rationale,
        });
      }
      return decisions.length;
    } catch (err) {
      logWarn('scanner', 'decision extraction failed', err);
      return 0;
    }
  }

  private async extractPatterns(
    sessionId: string,
    projectName: string,
    sourceFiles: ScannedFile[],
  ): Promise<boolean> {
    // Sample diverse files for pattern detection
    const samples = sourceFiles.slice(0, 25)
      .map(f => `### ${f.relativePath}\n${f.content.split('\n').slice(0, 40).join('\n')}`)
      .join('\n\n');

    const prompt = `Analyze these code excerpts and identify recurring patterns and conventions.

Project: ${projectName}

${samples.slice(0, 10000)}

Identifiziere:
1. **Naming Conventions** — Dateinamen, Variablen, Klassen
2. **Code Patterns** — wie werden Services strukturiert, Error Handling, State Management
3. **Projekt-Konventionen** — Import-Style, Export-Patterns, Verzeichnis-Konventionen
4. **Anti-Patterns / Inkonsistenzen** — wo weicht der Code von seinen eigenen Patterns ab

Antworte in Markdown, kompakt.`;

    try {
      const result = await this.chat!.chat(
        'You are a code review expert. Identify patterns and conventions.',
        prompt,
      );

      if (result) {
        await this.storeChunk(sessionId, {
          summary: `Code patterns and conventions in ${projectName}:\n\n${result}`,
          intent: 'refactor',
          component: 'project/conventions',
        });
        return true;
      }
    } catch (err) {
      logWarn('scanner', 'pattern extraction failed', err);
    }
    return false;
  }

  private async analyzeGitHistory(
    sessionId: string,
    projectPath: string,
    projectName: string,
  ): Promise<number> {
    // Get recent commit log
    const { stdout: log } = await execFileAsync('git', [
      'log', '--oneline', '--no-merges', '-100',
    ], { cwd: projectPath, timeout: 10_000 });

    if (!log.trim()) return 0;

    // Get reverts and big changes
    const { stdout: reverts } = await execFileAsync('git', [
      'log', '--oneline', '--grep=revert', '-i', '-20',
    ], { cwd: projectPath, timeout: 10_000 }).catch(() => ({ stdout: '' }));

    const { stdout: bigChanges } = await execFileAsync('git', [
      'log', '--oneline', '--shortstat', '-30',
    ], { cwd: projectPath, timeout: 10_000 }).catch(() => ({ stdout: '' }));

    if (!this.chat) {
      // Without AI, just store raw git summary
      await this.storeChunk(sessionId, {
        summary: `Git-History (letzte 100 Commits):\n\n${log.slice(0, 4000)}`,
        intent: 'question',
        component: 'project/history',
      });
      return 1;
    }

    const prompt = `Analyze this git history and extract learnings.

Project: ${projectName}

## Last 100 commits
${log.slice(0, 3000)}

${reverts ? `## Reverts\n${reverts.slice(0, 1000)}` : ''}

## Large changes (with stats)
${bigChanges.slice(0, 3000)}

Extract:
1. **Development phases** - which large features/refactors happened
2. **Problems & fixes** - what was fixed repeatedly, what was unstable
3. **Reverts/regressions** - what was rolled back and why (where inferable)
4. **Velocity patterns** - fast vs. slow phases

Respond with JSON ONLY (no code fences):
[{"learning": "...", "category": "phase|problem|revert|velocity", "relevance": "high|medium|low"}]`;

    try {
      const raw = await this.chat.chat(
        'You are an experienced engineering manager. Analyze git histories and extract actionable learnings.',
        prompt,
      );
      const learnings = filterValid(
        extractArray(raw, 'scanner'),
        (item): item is { learning: string; category: string; relevance: string } =>
          typeof item === 'object' && item !== null &&
          typeof (item as { learning?: unknown }).learning === 'string',
        'scanner',
        'git learnings',
      ).map(l => ({
        learning: l.learning,
        category: typeof l.category === 'string' ? l.category : 'unknown',
        relevance: typeof l.relevance === 'string' ? l.relevance : 'medium',
      }));

      if (learnings.length > 0) {
        const formatted = learnings
          .map(l => `- [${l.category}/${l.relevance}] ${l.learning}`)
          .join('\n');

        await this.storeChunk(sessionId, {
          summary: `Learnings from the git history of ${projectName}:\n\n${formatted}`,
          intent: 'question',
          component: 'project/history-learnings',
        });

        // Store high-relevance items as separate chunks for better retrieval
        for (const l of learnings.filter(l => l.relevance === 'high')) {
          await this.storeChunk(sessionId, {
            summary: `Git-Learning [${l.category}]: ${l.learning}`,
            intent: l.category === 'problem' ? 'bugfix' : 'architecture_decision',
            component: 'project/history',
          });
        }
      }

      return learnings.length;
    } catch (err) {
      logWarn('scanner', 'git analysis failed', err);
      return 0;
    }
  }

  private async generateArchSummary(
    projectName: string,
    tree: string,
    keyFiles: ScannedFile[],
    sourceFiles: ScannedFile[],
  ): Promise<string> {
    const keyFileSnippets = keyFiles
      .map(f => `### ${f.relativePath}\n${f.content.slice(0, 3000)}`)
      .join('\n\n');

    // Include first 50 lines of each source file for structure understanding
    const sourceSnippets = sourceFiles.slice(0, 20)
      .map(f => `### ${f.relativePath}\n${f.content.split('\n').slice(0, 30).join('\n')}`)
      .join('\n\n');

    const prompt = `Analyze this codebase and write an architecture summary.

Project: ${projectName}

## File structure
${tree.slice(0, 3000)}

## Key files
${keyFileSnippets.slice(0, 6000)}

## Source excerpts
${sourceSnippets.slice(0, 6000)}

Write a COMPACT summary (max 15-20 lines):
1. **Stack** - frontend, backend, infra (1 line each)
2. **Architecture** - layers and data flow (3-5 lines)
3. **Entry points** - where the app starts (1-2 lines)
4. **External dependencies** - APIs, services (1-2 lines)

IMPORTANT: do not enumerate individual packages. Summarize, do not list. Max 500 words.`;

    try {
      return await this.chat!.chat(
        'You are an experienced software architect. Analyze codebases and write precise summaries.',
        prompt,
      );
    } catch (err) {
      logWarn('scanner', 'architecture summary failed', err);
      return '';
    }
  }
}
