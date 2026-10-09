import { describe, it, expect } from 'vitest';
import { globMatch, matchProvider, defaultProvider, QWEN_PRESET, type ProviderConfig } from '../providers.js';
import { extractModel } from '../routes.js';
import { UpstreamClient } from '../upstreamClient.js';

const zen: ProviderConfig = { id: 'opencode-zen', name: 'Zen', baseUrl: 'https://opencode.ai/zen/v1', models: ['*'], enabled: true };
const qwen: ProviderConfig = { id: 'qwen', name: 'Qwen', baseUrl: 'http://127.0.0.1:8765/v1', models: ['qwen*'], enabled: true };

describe('provider glob matching', () => {
  it('matches * as catch-all', () => {
    expect(globMatch('*', 'anything-at-all')).toBe(true);
  });
  it('matches prefixes case-insensitively', () => {
    expect(globMatch('qwen*', 'Qwen-Max')).toBe(true);
    expect(globMatch('qwen*', 'gpt-4')).toBe(false);
  });
  it('matches exact ids', () => {
    expect(globMatch('qwen-max', 'qwen-max')).toBe(true);
    expect(globMatch('qwen-max', 'qwen-max-2')).toBe(false);
  });
});

describe('matchProvider', () => {
  it('routes qwen models to the qwen provider first', () => {
    expect(matchProvider([qwen, zen], 'qwen-max')?.id).toBe('qwen');
  });
  it('prefers specific patterns over the catch-all regardless of order', () => {
    expect(matchProvider([zen, qwen], 'qwen-max')?.id).toBe('qwen');
  });
  it('falls through to the catch-all for other models', () => {
    expect(matchProvider([qwen, zen], 'gpt-4o')?.id).toBe('opencode-zen');
  });
  it('skips disabled providers', () => {
    expect(matchProvider([{ ...qwen, enabled: false }, zen], 'qwen-max')?.id).toBe('opencode-zen');
  });
  it('returns null when nothing matches and no model given', () => {
    expect(matchProvider([qwen], 'gpt-4o')).toBeNull();
    expect(matchProvider([qwen, zen], undefined)).toBeNull();
  });
});

describe('defaultProvider', () => {
  it('prefers the catch-all provider', () => {
    expect(defaultProvider([qwen, zen])?.id).toBe('opencode-zen');
  });
  it('falls back to the first enabled provider', () => {
    expect(defaultProvider([qwen])?.id).toBe('qwen');
    expect(defaultProvider([])).toBeNull();
  });
});

describe('QWEN_PRESET', () => {
  it('is a valid enabled provider matching qwen models', () => {
    expect(QWEN_PRESET.enabled).toBe(true);
    expect(QWEN_PRESET.models.some((m) => globMatch(m, 'qwen-max'))).toBe(true);
    expect(new URL(QWEN_PRESET.baseUrl).hostname).toBeTruthy();
  });
});

describe('extractModel', () => {
  it('pulls the model from a chat completions body', () => {
    expect(extractModel(JSON.stringify({ model: 'qwen-max', messages: [] }))).toBe('qwen-max');
  });
  it('returns undefined for missing/invalid bodies', () => {
    expect(extractModel(undefined)).toBeUndefined();
    expect(extractModel('not json')).toBeUndefined();
    expect(extractModel(JSON.stringify({}))).toBeUndefined();
  });
});

describe('UpstreamClient.resolveBaseUrl', () => {
  const client = new UpstreamClient(null as never, null as never, null as never, undefined, undefined, () => [qwen, zen]);
  const acc = (over: Partial<{ baseUrl?: string; provider: string }>) => ({
    id: 'a', name: 'a', provider: 'qwen', apiKey: 'k', priority: 1, ...over,
  });
  it('prefers account.baseUrl', () => {
    expect(client.resolveBaseUrl(acc({ baseUrl: 'https://custom.example/v1/' }))).toBe('https://custom.example/v1');
  });
  it('falls back to the provider baseUrl', () => {
    expect(client.resolveBaseUrl(acc({}))).toBe('http://127.0.0.1:8765/v1');
  });
  it('falls back to the global upstreamBase for unknown providers', () => {
    expect(client.resolveBaseUrl(acc({ provider: 'nope' }))).toContain('opencode.ai');
  });
});
