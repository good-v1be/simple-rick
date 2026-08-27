#!/usr/bin/env node
// CRITICAL: This line MUST remain above ALL imports.
// MCP uses stdout for JSON-RPC. Any console.log corrupts the protocol.
console.log = console.error;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import fs from 'node:fs';
import { createDatabase, ensureVecTable, assertEmbeddingCompatible } from './db/sqlite.js';
import { loadOrCreateConfig } from './config.js';
import { createProviders } from './services/ai-providers.js';
import { SessionManager } from './services/session-manager.js';
import { Recorder } from './services/recorder.js';
import { LightweightNormalizer } from './services/lightweight-normalizer.js';
import { DeepNormalizer } from './services/deep-normalizer.js';
import { EdgeWirer } from './services/edge-wirer.js';
import { NormQueue } from './services/norm-queue.js';
import { Normalizer } from './services/normalizer.js';
import { Briefer } from './services/briefer.js';
import { FileWatcher } from './services/file-watcher.js';
import { CodebaseScanner } from './services/codebase-scanner.js';
import { VaultWriter } from './services/vault-writer.js';
import { NoteEmbedder } from './services/note-embedder.js';
import { DomainRouter } from './services/domain-router.js';
import { InsightEngine } from './services/insight/engine.js';
import { startHttpServer } from './http/server.js';
import { logInfo, logWarn } from './log.js';

// ── CLI arg parsing ────────────────────────────────────────────────────────
const projectArg = process.argv.indexOf('--project');
const PROJECT_PATH = projectArg >= 0 && process.argv[projectArg + 1]
  ? path.resolve(process.argv[projectArg + 1])
  : process.env['PROJECT_PATH'] ?? process.cwd();

// ── Ensure .simple-rick/ is in .gitignore ──────────────────────────────────
const gitignorePath = path.join(PROJECT_PATH, '.gitignore');
try {
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  if (!existing.includes('.simple-rick')) {
    fs.appendFileSync(gitignorePath, `\n# Simple Rick context engine\n.simple-rick/\n`);
    logInfo('startup', 'added .simple-rick/ to .gitignore');
  }
} catch (err) {
  logWarn('startup', 'could not add .simple-rick/ to .gitignore', err);
}

// ── DB + Config ────────────────────────────────────────────────────────────
const db = createDatabase(PROJECT_PATH);
const config = loadOrCreateConfig(db);

// ── AI Providers ───────────────────────────────────────────────────────────
const { embedding, chat } = createProviders(process.env as Record<string, string | undefined>);

// Refuse to run against embeddings of a different width rather than writing
// vectors that can never be queried back.
assertEmbeddingCompatible(
  { provider: config.embeddingProvider, dimension: config.embeddingDimension },
  { provider: embedding.name, dimension: embedding.dimension },
);

// Store embedding provider + dimension on first run
if (!config.embeddingDimension) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('embedding_dimension', ?)").run(String(embedding.dimension));
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('embedding_provider', ?)").run(embedding.name);
}
ensureVecTable(db, config.embeddingDimension ?? embedding.dimension);

// ── Write token file for Claude Code hooks ─────────────────────────────────
const tokenFilePath = path.join(PROJECT_PATH, '.simple-rick', '.token');
fs.writeFileSync(tokenFilePath, config.bearerToken, { encoding: 'utf-8', mode: 0o600 });
fs.chmodSync(tokenFilePath, 0o600); // mode above is ignored if the file already exists

// ── Services ───────────────────────────────────────────────────────────────
const sessionManager = new SessionManager(db);
const vaultWriter = new VaultWriter(path.join(PROJECT_PATH, '.simple-rick'));
const noteEmbedder = new NoteEmbedder(db, embedding);
const domainRouter = new DomainRouter(chat, vaultWriter, noteEmbedder);
const recorder = new Recorder(db, vaultWriter, noteEmbedder);
const deepNorm = new DeepNormalizer(db, chat, embedding);
const edgeWirer = new EdgeWirer(db);

// ── HTTP + WS ──────────────────────────────────────────────────────────────
const { broadcast } = startHttpServer(db, config.bearerToken, { recorder, sessionManager });

// ── Lightweight normalizer ─────────────────────────────────────────────────
const lightNorm = new LightweightNormalizer(db, chat);

// ── Norm Queue ─────────────────────────────────────────────────────────────
const normQueue = new NormQueue(db, lightNorm, deepNorm, edgeWirer, broadcast);
normQueue.start();

// Periodic queue:status broadcast
setInterval(() => {
  broadcast({ type: 'queue:status', ...normQueue.getStatus() });
}, 5000);

// ── Remaining services ─────────────────────────────────────────────────────
const normalizer = new Normalizer(db, vaultWriter, noteEmbedder, domainRouter, recorder, normQueue);
const briefer = new Briefer(db, vaultWriter, noteEmbedder);
const fileWatcher = new FileWatcher(db, PROJECT_PATH);
const codebaseScanner = new CodebaseScanner(db, chat, embedding);
const insightEngine = new InsightEngine(db, chat, embedding, broadcast);
normQueue.setInsightEngine(insightEngine);

// ── MCP Server ─────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'simple-rick', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ───────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'simple_rick_init',
      description: 'Initialize Simple Rick for a new project. Captures project name, stack and structure, and builds the initial context.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_name: { type: 'string', description: 'Project name' },
          description: { type: 'string', description: 'Short description of the project' },
          stack: { type: 'string', description: 'Tech stack (e.g. "Node.js, React, PostgreSQL")' },
          domains: {
            type: 'array', items: { type: 'string' },
            description: 'Project domains/modules (e.g. ["server", "client", "infra"])',
          },
        },
        required: ['project_name', 'description'],
      },
    },
    {
      name: 'simple_rick_briefing',
      description: 'Session start: returns context, open issues, learnings and recommendations. Call this at the beginning of every session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          focus: { type: 'string', description: 'Optional focus area (e.g. "voice feature" or "bugfixes")' },
        },
      },
    },
    {
      name: 'simple_rick_close',
      description: 'Session end: normalizes all message pairs, extracts learnings and creates embeddings. Always call this before ending a session.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'simple_rick_search',
      description: 'Semantic search across the entire project history.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query' },
          intent_filter: {
            type: 'string',
            enum: ['new_feature', 'feature_change', 'bugfix', 'error_diagnosis', 'refactor', 'config', 'architecture_decision', 'question'],
          },
          limit: { type: 'number', description: 'Max results (default: 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'simple_rick_ask',
      description: 'Ask a question about the code, past decisions or how things connect.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question: { type: 'string', description: 'The question' },
        },
        required: ['question'],
      },
    },
    {
      name: 'simple_rick_decision',
      description: 'Explicitly record an architecture or design decision.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          decision: { type: 'string', description: 'What was decided' },
          rationale: { type: 'string', description: 'Why' },
          component: { type: 'string', description: 'Affected component' },
          alternatives: { type: 'array', items: { type: 'string' }, description: 'Alternatives that were rejected' },
        },
        required: ['decision', 'rationale'],
      },
    },
    {
      name: 'simple_rick_link',
      description: 'Create an explicit cross-link between two chunks or concepts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          from: { type: 'string', description: 'Source chunk or description' },
          to: { type: 'string', description: 'Target chunk or description' },
          relation: { type: 'string', description: 'Type of relation' },
        },
        required: ['from', 'to', 'relation'],
      },
    },
    {
      name: 'simple_rick_insights',
      description: 'Generate insights from the knowledge base. Finds correlations, trends and anomalies between entities and validates them with an LLM.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          mode: {
            type: 'string',
            enum: ['deep', 'semantic', 'chains', 'all'],
            description: 'Scan mode: "deep" (correlations/trends), "semantic" (embedding similarity), "chains" (transitive causal chains), "all" (all three)',
          },
        },
      },
    },
  ],
}));

// ── Tool handlers ──────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'simple_rick_init': {
        const { project_name, description, stack, domains } = args as {
          project_name: string; description: string; stack?: string; domains?: string[];
        };

        const sessionId = sessionManager.ensureSession();

        const meta = [
          `Projekt "${project_name}" initialisiert.`,
          description,
          stack ? `Stack: ${stack}` : null,
          domains?.length ? `Domains: ${domains.join(', ')}` : null,
        ].filter(Boolean).join('\n');

        await recorder.recordDecision(
          sessionId,
          `Projekt-Initialisierung: ${project_name}`,
          meta,
          'project/root',
        );

        console.error(`[simple-rick] Scanning codebase at ${PROJECT_PATH}...`);
        const scanResult = await codebaseScanner.scanAndStore(sessionId, PROJECT_PATH, project_name);
        console.error(`[simple-rick] Codebase scan complete`);

        const response = [
          `## Simple Rick initialisiert`,
          `**Projekt:** ${project_name}`,
          `**Beschreibung:** ${description}`,
          stack ? `**Stack:** ${stack}` : null,
          domains?.length ? `**Domains:** ${domains.join(', ')}` : null,
          '',
          scanResult,
          '',
          `**UI:** http://127.0.0.1:3777?token=${config.bearerToken}`,
          '',
          'Nutze `simple_rick_briefing` am Anfang jeder Session.',
          'Nutze `simple_rick_close` am Ende jeder Session.',
          'Nutze `simple_rick_decision` um wichtige Entscheidungen zu dokumentieren.',
        ].filter(Boolean).join('\n');

        return { content: [{ type: 'text', text: response }] };
      }

      case 'simple_rick_briefing': {
        const sessionId = sessionManager.ensureSession();
        const focus = (args as { focus?: string }).focus;
        const briefing = await briefer.generateBriefing(sessionId, focus);
        return { content: [{ type: 'text', text: briefing }] };
      }

      case 'simple_rick_close': {
        const sessionId = sessionManager.ensureSession();
        const summary = await normalizer.closeSession(sessionId);
        sessionManager.closeSession(sessionId, summary);
        broadcast({ type: 'session:closed', sessionId });
        return { content: [{ type: 'text', text: summary }] };
      }

      case 'simple_rick_search': {
        const { query, intent_filter, limit } = args as {
          query: string; intent_filter?: string; limit?: number;
        };
        const results = await briefer.search(query, intent_filter, limit ?? 10);
        return { content: [{ type: 'text', text: results }] };
      }

      case 'simple_rick_ask': {
        const { question } = args as { question: string };
        const answer = await briefer.ask(question);
        return { content: [{ type: 'text', text: answer }] };
      }

      case 'simple_rick_decision': {
        const sessionId = sessionManager.ensureSession();
        const { decision, rationale, component, alternatives } = args as {
          decision: string; rationale: string; component?: string; alternatives?: string[];
        };
        await recorder.recordDecision(sessionId, decision, rationale, component, alternatives);
        broadcast({ type: 'turn:ingested', chunk_id: null, domain: 'Code', entities: [component ?? 'unknown'] });

        return { content: [{ type: 'text', text: `Decision recorded: ${decision}` }] };
      }

      case 'simple_rick_link': {
        const sessionId = sessionManager.ensureSession();
        const { from, to, relation } = args as { from: string; to: string; relation: string };
        await recorder.recordLink(sessionId, from, to, relation);
        return { content: [{ type: 'text', text: `Link created: ${from} —[${relation}]→ ${to}` }] };
      }

      case 'simple_rick_insights': {
        const mode = (args as { mode?: string }).mode ?? 'all';
        const allLogs: string[] = [];
        let totalInsights = 0;

        if (mode === 'deep' || mode === 'all') {
          const { log, insightsCreated } = await insightEngine.deepScan();
          allLogs.push('## Deep Scan (Korrelationen & Trends)', ...log, '');
          totalInsights += insightsCreated;
        }
        if (mode === 'semantic' || mode === 'all') {
          const { log, insightsCreated } = await insightEngine.semanticScan();
          allLogs.push('## Semantic Scan (Embedding-Aehnlichkeit)', ...log, '');
          totalInsights += insightsCreated;
        }
        if (mode === 'chains' || mode === 'all') {
          const { log, chainsFound } = await insightEngine.findTransitiveChains();
          allLogs.push('## Transitive Chains', ...log, '');
          totalInsights += chainsFound;
        }

        allLogs.push(`---`, `**Total: ${totalInsights} insight(s) generated**`);
        return { content: [{ type: 'text', text: allLogs.join('\n') }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${String(err)}` }], isError: true };
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
fileWatcher.setSessionResolver(async () => sessionManager.ensureSession());
fileWatcher.start();
console.error(`[simple-rick] Watching ${PROJECT_PATH}`);

// MCP transport: only connect if stdin is a pipe (i.e., launched by a CLI tool).
// When run standalone (for UI-only mode), just keep the process alive via HTTP server.
if (!process.stdin.isTTY) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[simple-rick] MCP server running (stdio)');
} else {
  console.error('[simple-rick] Standalone mode (no MCP client — UI only)');
}
