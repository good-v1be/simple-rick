/**
 * Parsing and validation of JSON returned by an LLM.
 *
 * Models return almost-JSON: wrapped in code fences, with a sentence in front,
 * with a string where a number belongs. Every helper here therefore *coerces
 * and logs* rather than throwing — a single malformed response must never take
 * down the normalization pipeline. What it must not do is pass silently, which
 * is what plain `JSON.parse(...) ?? {}` used to do.
 */

import { logWarn } from '../log.js';

/** Strip code fences so the JSON matcher does not trip over them. */
function stripFences(raw: string): string {
  return raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
}

/**
 * Pull the first JSON object out of a model response.
 * Returns {} (and logs) when there is nothing usable.
 */
export function extractObject(raw: string, scope: string): Record<string, unknown> {
  const cleaned = stripFences(raw);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    logWarn(scope, 'no JSON object in model response, using defaults', cleaned.slice(0, 200));
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logWarn(scope, 'model returned JSON that is not an object, using defaults', cleaned.slice(0, 200));
    return {};
  } catch (err) {
    logWarn(scope, 'model returned malformed JSON, using defaults', err);
    return {};
  }
}

/**
 * Pull the first JSON array out of a model response.
 * Returns [] (and logs) when there is nothing usable.
 */
export function extractArray(raw: string, scope: string): unknown[] {
  const cleaned = stripFences(raw);
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) {
    logWarn(scope, 'no JSON array in model response, using empty list', cleaned.slice(0, 200));
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed;
    logWarn(scope, 'model returned JSON that is not an array, using empty list', cleaned.slice(0, 200));
    return [];
  } catch (err) {
    logWarn(scope, 'model returned malformed JSON array, using empty list', err);
    return [];
  }
}

/** Coerce to a string, falling back (with a log line) when the field is absent or of the wrong type. */
export function asString(value: unknown, fallback: string, scope: string, field: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (value !== undefined && value !== null) {
    logWarn(scope, `field "${field}" was not a string, using fallback`, value);
  }
  return fallback;
}

/** Coerce to an array of non-empty strings, dropping anything that is not one. */
export function asStringArray(value: unknown, scope: string, field: string, max = 100): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    logWarn(scope, `field "${field}" was not an array, using empty list`, value);
    return [];
  }
  const out = value
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .slice(0, max);
  if (out.length !== value.length) {
    logWarn(scope, `field "${field}" contained ${value.length - out.length} unusable entries, dropped`);
  }
  return out;
}

/**
 * Coerce to an integer inside [min, max].
 * Accepts numeric strings, because models routinely return "7" instead of 7.
 */
export function asInt(
  value: unknown,
  { min, max, fallback }: { min: number; max: number; fallback: number },
  scope: string,
  field: string,
): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    if (value !== undefined && value !== null) {
      logWarn(scope, `field "${field}" was not a number, using ${fallback}`, value);
    }
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, Math.round(n)));
  if (clamped !== n) {
    logWarn(scope, `field "${field}" was out of range [${min}, ${max}], clamped to ${clamped}`, value);
  }
  return clamped;
}

/** Coerce to one of a fixed set of strings. */
export function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  scope: string,
  field: string,
): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  if (value !== undefined && value !== null) {
    logWarn(scope, `field "${field}" was not one of ${allowed.join('|')}, using "${fallback}"`, value);
  }
  return fallback;
}

/** Keep only the array entries that satisfy `isValid`, logging how many were dropped. */
export function filterValid<T>(
  items: unknown[],
  isValid: (item: unknown) => item is T,
  scope: string,
  what: string,
): T[] {
  const out = items.filter(isValid);
  if (out.length !== items.length) {
    logWarn(scope, `dropped ${items.length - out.length} malformed ${what} from model response`);
  }
  return out;
}
