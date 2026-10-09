import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountPool } from '../accountPool.js';
import { Metrics } from '../metrics.js';
import { Alerter } from '../alerts.js';
import { UpstreamClient } from '../upstreamClient.js';
import { saveSettings } from '../settings.js';
import type { AccountConfig } from '../config.js';
import type { ProviderConfig } from '../providers.js';

const acc = (id: string, priority: number, provider = 'p'): AccountConfig => ({ id, name: id, provider, apiKey: 'k', priority });
const prov: ProviderConfig = { id: 'p', name: 'P', baseUrl: 'http://p.invalid/v1', models: ['*'], enabled: true };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  saveSettings({ maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, routingStrategy: 'priority', queueMaxWaitMs: 30000 });
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('latency-based routing', () => {
  it('prefers the fastest account in latency mode', () => {
    saveSettings({ routingStrategy: 'latency' });
    const pool = new AccountPool([acc('slow', 1), acc('fast', 2)]);
    pool.recordLatency('slow', 2000);
    pool.recordLatency('fast', 100);
    expect(pool.acquire()?.id).toBe('fast');
  });

  it('keeps priority order in priority mode (latency only breaks ties)', () => {
    saveSettings({ routingStrategy: 'priority' });
    const pool = new AccountPool([acc('slow', 1), acc('fast', 2)]);
    pool.recordLatency('slow', 2000);
    pool.recordLatency('fast', 100);
    expect(pool.acquire()?.id).toBe('slow');
  });

  it('tries unknown-latency accounts first in latency mode', () => {
    saveSettings({ routingStrategy: 'latency' });
    const pool = new AccountPool([acc('known', 1), acc('fresh', 1)]);
    pool.recordLatency('known', 500);
    expect(pool.acquire()?.id).toBe('fresh');
  });

  it('exposes avg latency in status()', () => {
    const pool = new AccountPool([acc('a', 1)]);
    pool.recordLatency('a', 120);
    pool.recordLatency('a', 180);
    const st = pool.status()[0];
    expect(st.avgLatencyMs).toBeGreaterThan(0);
  });
});

describe('request queue', () => {
  it('nextAvailableIn reports the soonest cooldown', async () => {
    const pool = new AccountPool([acc('a', 1)]);
    pool.markLimited('a', 120);
    const wait = pool.nextAvailableIn();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(120);
    await sleep(140);
    expect(pool.nextAvailableIn()).toBe(0);
  });

  it('waits for a cooling account instead of throwing 503', async () => {
    saveSettings({ queueMaxWaitMs: 5000 });
    const pool = new AccountPool([acc('a', 1, 'p')]);
    pool.markLimited('a', 60);
    const rotator = { current: () => null, dispatcherFor: () => undefined, rotate: () => {}, egressLabel: () => 'd', currentFamily: () => 4 } as never;
    const sessions = { id: 's', rotate: () => {} } as never;
    const client = new UpstreamClient(pool, rotator, sessions, new Metrics(), undefined, () => [prov]);
    const res = await client.forward({
      method: 'POST', path: '/chat/completions', query: '', headers: {},
      bodyText: JSON.stringify({ model: 'm', messages: [] }), provider: 'p',
    });
    expect(res.status).toBe(200);
  });

  it('still fails fast when the wait exceeds the cap', async () => {
    saveSettings({ queueMaxWaitMs: 10 });
    const pool = new AccountPool([acc('a', 1, 'p')]);
    pool.markLimited('a', 60000);
    const rotator = { current: () => null, dispatcherFor: () => undefined, rotate: () => {}, egressLabel: () => 'd', currentFamily: () => 4 } as never;
    const sessions = { id: 's', rotate: () => {} } as never;
    const client = new UpstreamClient(pool, rotator, sessions, new Metrics(), undefined, () => [prov]);
    await expect(
      client.forward({ method: 'POST', path: '/chat/completions', query: '', headers: {}, bodyText: JSON.stringify({ model: 'm' }), provider: 'p' }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('Alerter', () => {
  it('POSTs JSON and dedupes within the cooldown', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: unknown) => {
      calls.push((init as { body: string }).body);
      return new Response('ok');
    });
    const alerter = new Alerter(() => 'https://hooks.example/alert');
    await alerter.send('dead_key', 'key parked');
    await alerter.send('dead_key', 'key parked again');
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0] as string) as { event: string; text: string };
    expect(payload.event).toBe('dead_key');
    expect(payload.text).toContain('opencode-max');
  });

  it('does nothing without a URL and never throws', async () => {
    const alerter = new Alerter(() => '');
    await expect(alerter.send('x', 'y')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', async () => {
      throw new Error('down');
    });
    const alerter2 = new Alerter(() => 'https://hooks.example/alert');
    await expect(alerter2.send('x', 'y')).resolves.toBeUndefined();
  });
});

describe('modelStats', () => {
  it('aggregates requests, errors and latency per model', () => {
    const metrics = new Metrics();
    metrics.logRequest('a1', 200, 100, 'qwen-max');
    metrics.logRequest('a1', 200, 300, 'qwen-max');
    metrics.logRequest('a2', 500, 50, 'qwen-max');
    metrics.logRequest('a2', 200, 80, 'gpt-4o');
    const stats = metrics.modelStats(24, (id) => (id === 'a1' ? 'zen' : 'qwen'));
    const qwen = stats.find((s) => s.model === 'qwen-max');
    expect(qwen?.requests).toBe(3);
    expect(qwen?.errors).toBe(1);
    expect(qwen?.avgLatencyMs).toBe(150);
    expect(qwen?.provider).toBe('zen'); // top provider by requests
    const gpt = stats.find((s) => s.model === 'gpt-4o');
    expect(gpt?.requests).toBe(1);
  });
});
