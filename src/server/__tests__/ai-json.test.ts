import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractObject, extractArray, asString, asStringArray, asInt, asEnum, filterValid } from '../services/ai-json.js';

// The helpers log to stderr on every fallback; silence that for the run.
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('extractObject', () => {
  it('parses a bare object', () => {
    expect(extractObject('{"a":1}', 't')).toEqual({ a: 1 });
  });

  it('parses through code fences and surrounding prose', () => {
    expect(extractObject('Sure!\n```json\n{"a":1}\n```\n', 't')).toEqual({ a: 1 });
  });

  it('returns {} for malformed JSON instead of throwing', () => {
    expect(extractObject('{"a": }', 't')).toEqual({});
  });

  it('returns {} when the model answered in prose', () => {
    expect(extractObject('I cannot do that', 't')).toEqual({});
  });

  it('returns {} when given an array', () => {
    expect(extractObject('[1,2]', 't')).toEqual({});
  });
});

describe('extractArray', () => {
  it('parses a fenced array', () => {
    expect(extractArray('```json\n[{"x":1}]\n```', 't')).toEqual([{ x: 1 }]);
  });

  it('returns [] for prose', () => {
    expect(extractArray('no results', 't')).toEqual([]);
  });
});

describe('asInt', () => {
  const range = { min: 1, max: 10, fallback: 5 };

  it('accepts numbers in range', () => {
    expect(asInt(7, range, 't', 'f')).toBe(7);
  });

  it('accepts numeric strings, which models often return', () => {
    expect(asInt('7', range, 't', 'f')).toBe(7);
  });

  it('clamps out-of-range values', () => {
    expect(asInt(99, range, 't', 'f')).toBe(10);
    expect(asInt(-4, range, 't', 'f')).toBe(1);
  });

  it('falls back on non-numbers rather than producing NaN', () => {
    expect(asInt('high', range, 't', 'f')).toBe(5);
    expect(asInt(undefined, range, 't', 'f')).toBe(5);
    expect(asInt(null, range, 't', 'f')).toBe(5);
  });
});

describe('asStringArray', () => {
  it('keeps strings and drops everything else', () => {
    expect(asStringArray(['a', 3, null, 'b', ''], 't', 'f')).toEqual(['a', 'b']);
  });

  it('returns [] when the model sent a string instead of an array', () => {
    expect(asStringArray('a,b', 't', 'f')).toEqual([]);
  });

  it('honours the cap', () => {
    expect(asStringArray(['a', 'b', 'c'], 't', 'f', 2)).toEqual(['a', 'b']);
  });
});

describe('asString / asEnum', () => {
  it('falls back on empty and non-string values', () => {
    expect(asString('  ', 'fb', 't', 'f')).toBe('fb');
    expect(asString(42, 'fb', 't', 'f')).toBe('fb');
    expect(asString('ok', 'fb', 't', 'f')).toBe('ok');
  });

  it('only accepts allowed enum members', () => {
    const allowed = ['Code', 'Testing'] as const;
    expect(asEnum('Code', allowed, 'Testing', 't', 'f')).toBe('Code');
    expect(asEnum('Nonsense', allowed, 'Testing', 't', 'f')).toBe('Testing');
  });
});

describe('filterValid', () => {
  it('drops entries failing the guard', () => {
    const isPair = (i: unknown): i is { cause: string; effect: string } =>
      typeof i === 'object' && i !== null && typeof (i as any).cause === 'string' && typeof (i as any).effect === 'string';
    expect(filterValid([{ cause: 'a', effect: 'b' }, 'nope', { cause: 1 }], isPair, 't', 'pairs'))
      .toEqual([{ cause: 'a', effect: 'b' }]);
  });
});
