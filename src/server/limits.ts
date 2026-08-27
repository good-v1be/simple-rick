/**
 * Tunable limits.
 *
 * These were constants scattered across the services, which meant a large
 * project silently hit the scan ceiling and a small one wasted API calls, with
 * no way to change either. Values are read once at startup from the
 * environment; anything unset or unparseable falls back to the previous
 * hardcoded default.
 */

import { logWarn } from './log.js';

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    logWarn('limits', `${name}="${raw}" is not a number >= ${min}, using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

export const LIMITS = {
  /** Largest file the codebase scanner will read, in bytes. */
  maxFileSize: intFromEnv('SIMPLE_RICK_MAX_FILE_SIZE', 50_000, 1_000),
  /** Most files the codebase scanner will walk. */
  maxFiles: intFromEnv('SIMPLE_RICK_MAX_FILES', 500, 1),
  /** Pause between normalization queue passes, in milliseconds. */
  queueThrottleMs: intFromEnv('SIMPLE_RICK_QUEUE_THROTTLE_MS', 2_000, 100),
} as const;
