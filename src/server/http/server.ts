import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type Database from 'better-sqlite3';
import { createRoutes, type RouteContext } from './routes.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function startHttpServer(
  db: Database.Database,
  token: string,
  ctx: RouteContext = {},
  port = 3777,
  host = '127.0.0.1',
): { server: http.Server; broadcast: (event: Record<string, unknown>) => void } {
  // Inject broadcast into ctx so routes can use it
  const routeCtx = { ...ctx };
  const routes = createRoutes(db, token, routeCtx);
  const server = http.createServer(routes);
  const clients = new Set<WebSocket>();

  function broadcast(event: Record<string, unknown>): void {
    const msg = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
  routeCtx.broadcast = broadcast;

  function attachWebSocket(): void {
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      // Match the origin's hostname exactly. A substring check would let
      // https://localhost.example.com through.
      const origin = req.headers.origin ?? '';
      if (origin !== '' && !isLoopbackOrigin(origin)) {
        ws.close(4003, 'Forbidden origin');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.searchParams.get('token') !== token) {
        ws.close(4001, 'Unauthorized');
        return;
      }
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
    });
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[simple-rick] Port ${port} in use, trying random port...`);
      server.listen(0, host);
    } else {
      console.error(`[simple-rick] HTTP server error:`, err.message);
    }
  });

  server.on('listening', () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    console.error(`[simple-rick] UI: http://${host}:${actualPort}?token=${token}`);
    attachWebSocket();
  });

  server.listen(port, host);

  return { server, broadcast };
}
