import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { Recorder } from '../services/recorder.js';
import type { SessionManager } from '../services/session-manager.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RouteContext {
  recorder?: Recorder;
  sessionManager?: SessionManager;
  broadcast?: (event: Record<string, unknown>) => void;
}

export function createRoutes(db: Database.Database, token: string, ctx: RouteContext = {}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Serve UI — inject token into HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const htmlPath = path.join(__dirname, '../ui/index.html');
      if (!fs.existsSync(htmlPath)) {
        res.writeHead(404);
        res.end('UI not found');
        return;
      }
      let html = fs.readFileSync(htmlPath, 'utf-8');
      html = html.replace(/\{\{TOKEN\}\}/g, token);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // Auth check for API
    const authToken = url.searchParams.get('token')
      ?? req.headers.authorization?.replace('Bearer ', '');
    if (authToken !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // GET /api/graph
    if (url.pathname === '/api/graph') {
      const chunks = db.prepare(
        "SELECT id, normalized_text, domain, entities, severity, source_type, created_at FROM chunks WHERE norm_status = 'done'"
      ).all();
      const edges = db.prepare('SELECT * FROM edges').all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nodes: chunks, edges }));
      return;
    }

    // GET /api/chunks/:id
    const chunkMatch = url.pathname.match(/^\/api\/chunks\/(.+)$/);
    if (chunkMatch) {
      const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkMatch[1]);
      if (!chunk) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(chunk));
      return;
    }

    // GET /api/sessions
    if (url.pathname === '/api/sessions') {
      const sessions = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 20').all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
      return;
    }

    // POST /api/record — receive turns from Claude Code hooks
    if (req.method === 'POST' && url.pathname === '/api/record' && ctx.recorder && ctx.sessionManager) {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { role, content, tool_name, tool_input } = JSON.parse(body) as {
            role: 'user' | 'ai' | 'tool_call' | 'tool_result';
            content: string;
            tool_name?: string;
            tool_input?: string;
          };
          if (!role || !content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'role and content required' }));
            return;
          }
          const sessionId = ctx.sessionManager!.ensureSession();
          const result = await ctx.recorder!.recordMessage(sessionId, role, content, tool_name, tool_input);
          ctx.broadcast?.({ type: 'turn:ingested', ...result });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  };
}
