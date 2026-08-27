/**
 * Logging for an MCP server.
 *
 * MCP speaks JSON-RPC over stdout, so every message here goes to stderr.
 * `console.log` is reassigned to `console.error` in index.ts as a backstop,
 * but code should call these helpers rather than relying on that.
 *
 * Level is set with SIMPLE_RICK_LOG_LEVEL=error|warn|info|debug (default: info).
 */

const ORDER = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof ORDER)[number];

function threshold(): number {
  const raw = (process.env['SIMPLE_RICK_LOG_LEVEL'] ?? 'info').toLowerCase();
  const idx = (ORDER as readonly string[]).indexOf(raw);
  return idx === -1 ? ORDER.indexOf('info') : idx;
}

/** Render an unknown value compactly enough to stay readable in a terminal. */
function describe(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) return ` ${detail.name}: ${detail.message}`;
  if (typeof detail === 'string') return ` ${detail.slice(0, 500)}`;
  try {
    return ` ${JSON.stringify(detail).slice(0, 500)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

export function log(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  if (ORDER.indexOf(level) > threshold()) return;
  console.error(`[simple-rick:${scope}] ${level.toUpperCase()} ${message}${describe(detail)}`);
}

export const logError = (scope: string, message: string, detail?: unknown) => log('error', scope, message, detail);
export const logWarn = (scope: string, message: string, detail?: unknown) => log('warn', scope, message, detail);
export const logInfo = (scope: string, message: string, detail?: unknown) => log('info', scope, message, detail);
export const logDebug = (scope: string, message: string, detail?: unknown) => log('debug', scope, message, detail);
