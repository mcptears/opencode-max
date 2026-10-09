import { describe, it, expect, beforeEach } from 'vitest';
import { parseModelTimeouts, resolveModelTimeout, saveSettings, getSettings } from '../settings.js';

beforeEach(() => {
  saveSettings({ modelTimeouts: {} });
});

describe('parseModelTimeouts', () => {
  it('parses a valid map', () => {
    expect(parseModelTimeouts('{"a": 30000, "b*": 600000}')).toEqual({ a: 30000, 'b*': 600000 });
  });

  it('drops non-numeric, tiny and negative values', () => {
    expect(parseModelTimeouts('{"a": "x", "b": 500, "c": -1, "d": 1500}')).toEqual({ d: 1500 });
  });

  it('returns {} for garbage', () => {
    expect(parseModelTimeouts('nope')).toEqual({});
    expect(parseModelTimeouts(undefined)).toEqual({});
    expect(parseModelTimeouts('[1,2]')).toEqual({});
  });
});

describe('resolveModelTimeout', () => {
  const map = { 'exact-model': 11111, 'slow-*': 22222 };
  it('prefers an exact match', () => {
    expect(resolveModelTimeout(map, 'exact-model', 120000)).toBe(11111);
  });

  it('falls back to a matching glob', () => {
    expect(resolveModelTimeout(map, 'slow-thinker', 120000)).toBe(22222);
  });

  it('uses the default when nothing matches', () => {
    expect(resolveModelTimeout(map, 'other', 120000)).toBe(120000);
    expect(resolveModelTimeout(map, undefined, 120000)).toBe(120000);
    expect(resolveModelTimeout({}, 'x', 120000)).toBe(120000);
  });

  it('exact match beats a glob that would also match', () => {
    expect(resolveModelTimeout({ 'slow-*': 22222, 'slow-one': 33333 }, 'slow-one', 120000)).toBe(33333);
  });
});

describe('modelTimeouts setting', () => {
  it('round-trips through saveSettings', () => {
    saveSettings({ modelTimeouts: { 'qwen-*': 600000 } });
    expect(getSettings().modelTimeouts).toEqual({ 'qwen-*': 600000 });
  });
});
