import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountPool } from '../accountPool.js';
import { Metrics } from '../metrics.js';
import { Alerter } from '../alerts.js';
import { UpstreamClient } from '../upstreamClient.js';
import { saveSettings, getSettings } from '../settings.js';
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

describe('recentRequests', () => {
  it('returns newest-first request rows with provider mapping', () => {
    const metrics = new Metrics();
    metrics.logRequest('zz1', 200, 100, 'mm1');
    metrics.logRequest('zz2', 500, 200, 'mm2');
    const rows = metrics.recentRequests(10, (id) => (id === 'zz1' ? 'zen' : id === 'zz2' ? 'qwen' : ''));
    const zz = rows.filter((r) => r.accountId === 'zz1' || r.accountId === 'zz2');
    expect(zz).toHaveLength(2);
    expect(zz[0].accountId).toBe('zz2'); // newest first
    expect(zz[0].provider).toBe('qwen');
    expect(zz[0].status).toBe(500);
    expect(zz[1].provider).toBe('zen');
  });
});

describe('concurrency caps', () => {
  it('skips accounts at the cap and re-admits after release', () => {
    saveSettings({ accountConcurrency: 1 });
    const pool = new AccountPool([
      { id: 'a', name: 'a', provider: 'p', apiKey: 'k', priority: 1 },
      { id: 'b', name: 'b', provider: 'p', apiKey: 'k', priority: 2 },
    ]);
    expect(pool.acquire('p')?.id).toBe('a');
    expect(pool.acquire('p')?.id).toBe('b'); // a is at cap
    expect(pool.acquire('p')).toBeNull(); // both at cap
    pool.release('a');
    expect(pool.acquire('p')?.id).toBe('a');
    pool.release('a');
    pool.release('b');
  });

  it('is unlimited when cap is 0', () => {
    saveSettings({ accountConcurrency: 0 });
    const pool = new AccountPool([{ id: 'a', name: 'a', provider: 'p', apiKey: 'k', priority: 1 }]);
    expect(pool.acquire('p')?.id).toBe('a');
    expect(pool.acquire('p')?.id).toBe('a');
    expect(pool.status()[0].inflight).toBe(0); // not tracked when unlimited
  });

  it('forward() releases the slot on success', async () => {
    saveSettings({ accountConcurrency: 2, maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1 });
    const pool = new AccountPool([{ id: 'a', name: 'a', provider: 'p', apiKey: 'k', priority: 1 }]);
    const rotator = { current: () => null, dispatcherFor: () => undefined, rotate: () => {}, egressLabel: () => 'd', currentFamily: () => 4 } as never;
    const sessions = { id: 's', rotate: () => {} } as never;
    const client = new UpstreamClient(pool, rotator, sessions, new Metrics(), undefined, () => [
      { id: 'p', name: 'P', baseUrl: 'http://p.invalid/v1', models: ['*'], enabled: true },
    ]);
    await client.forward({ method: 'POST', path: '/chat/completions', query: '', headers: {}, bodyText: JSON.stringify({ model: 'm' }), provider: 'p' });
    expect(pool.status()[0].inflight).toBe(0);
  });
});

describe('concurrency queue', () => {
  it('atCap/hasCapacity reflect the cap', () => {
    saveSettings({ accountConcurrency: 1 });
    const pool = new AccountPool([{ id: 'a', name: 'a', provider: 'p', apiKey: 'k', priority: 1 }]);
    expect(pool.atCap('p')).toBe(false);
    expect(pool.hasCapacity('p')).toBe(true);
    expect(pool.acquire('p')?.id).toBe('a');
    expect(pool.atCap('p')).toBe(true);
    expect(pool.hasCapacity('p')).toBe(false);
    pool.release('a');
    expect(pool.atCap('p')).toBe(false);
    expect(pool.hasCapacity('p')).toBe(true);
  });

  it('queues for a slot instead of 502ing', async () => {
    saveSettings({ accountConcurrency: 1, queueMaxWaitMs: 5000, maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1 });
    const pool = new AccountPool([{ id: 'a', name: 'a', provider: 'p', apiKey: 'k', priority: 1 }]);
    // Hold the only slot, then release it after 120ms.
    expect(pool.acquire('p')?.id).toBe('a');
    setTimeout(() => pool.release('a'), 120);
    const rotator = { current: () => null, dispatcherFor: () => undefined, rotate: () => {}, egressLabel: () => 'd', currentFamily: () => 4 } as never;
    const sessions = { id: 's', rotate: () => {} } as never;
    const client = new UpstreamClient(pool, rotator, sessions, new Metrics(), undefined, () => [
      { id: 'p', name: 'P', baseUrl: 'http://p.invalid/v1', models: ['*'], enabled: true },
    ]);
    const res = await client.forward({ method: 'POST', path: '/chat/completions', query: '', headers: {}, bodyText: JSON.stringify({ model: 'm' }), provider: 'p' });
    expect(res.status).toBe(200);
    expect(pool.status()[0].inflight).toBe(0);
  });
});

describe('proxy quality scoring', () => {
  it('tracks ok/fail counts and latency EMA', async () => {
    const { IpRotator } = await import('../ipRotator.js');
    const r = new IpRotator(['http://p1:8080', 'http://p2:8080']);
    r.recordProxyResult('http://p1:8080', true, 100);
    r.recordProxyResult('http://p1:8080', true, 200);
    r.recordProxyResult('http://p1:8080', false, 0);
    const q = r.qualityOf('http://p1:8080');
    expect(q?.ok).toBe(2);
    expect(q?.fail).toBe(1);
    expect(q?.consecFails).toBe(1);
    expect(q?.latencyEma).toBeGreaterThan(0);
    // success resets consecutive failures
    r.recordProxyResult('http://p1:8080', true, 100);
    expect(r.qualityOf('http://p1:8080')?.consecFails).toBe(0);
  });

  it('auto-drops after the threshold but never the last proxy', async () => {
    const { IpRotator } = await import('../ipRotator.js');
    const { saveSettings } = await import('../settings.js');
    saveSettings({ proxyAutoDropFails: 2 });
    const dropped: string[] = [];
    const r = new IpRotator(['http://p1:8080', 'http://p2:8080']);
    r.onProxyDropped = (p) => dropped.push(p);
    r.recordProxyResult('http://p1:8080', false, 0);
    expect(r.count).toBe(2);
    r.recordProxyResult('http://p1:8080', false, 0);
    expect(r.count).toBe(1);
    expect(dropped).toEqual(['http://p1:8080']);
    expect(r.rawProxies()).toEqual(['http://p2:8080']);
    // last proxy is never dropped
    r.recordProxyResult('http://p2:8080', false, 0);
    r.recordProxyResult('http://p2:8080', false, 0);
    r.recordProxyResult('http://p2:8080', false, 0);
    expect(r.count).toBe(1);
    expect(dropped).toHaveLength(1);
  });

  it('does not auto-drop when disabled', async () => {
    const { IpRotator } = await import('../ipRotator.js');
    const { saveSettings } = await import('../settings.js');
    saveSettings({ proxyAutoDropFails: 0 });
    const r = new IpRotator(['http://p1:8080', 'http://p2:8080']);
    for (let i = 0; i < 10; i++) r.recordProxyResult('http://p1:8080', false, 0);
    expect(r.count).toBe(2);
    saveSettings({ proxyAutoDropFails: 5 });
  });
});

describe('model fallback chains', () => {
  const prov = (id: string, models: string[], base: string) => ({ id, name: id, baseUrl: base, models, enabled: true });
  const mk = (accounts: { id: string; provider: string }[], providers: { id: string; models: string[]; baseUrl: string }[]) => {
    const pool = new AccountPool(accounts.map((a) => ({ id: a.id, name: a.id, provider: a.provider, apiKey: 'k', priority: 1 })));
    const rotator = { current: () => null, dispatcherFor: () => undefined, rotate: () => {}, egressLabel: () => 'd', currentFamily: () => 4 } as never;
    const sessions = { id: 's', rotate: () => {} } as never;
    return new UpstreamClient(pool, rotator, sessions, new Metrics(), undefined, () => providers.map((p) => prov(p.id, p.models, p.baseUrl)));
  };

  it('falls back to the next model when the primary is exhausted', async () => {
    saveSettings({ maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, modelFallbacks: { 'm1': ['m2'] } });
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { model: string };
      seen.push(body.model);
      if (String(url).includes('down.invalid')) throw new Error('down');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = mk([{ id: 'a', provider: 'p1' }, { id: 'b', provider: 'p2' }], [
      { id: 'p1', models: ['m1'], baseUrl: 'http://down.invalid/v1' },
      { id: 'p2', models: ['m2'], baseUrl: 'http://up.invalid/v1' },
    ]);
    const res = await client.forward({ method: 'POST', path: '/chat/completions', query: '', headers: {}, bodyText: JSON.stringify({ model: 'm1' }), provider: 'p1' });
    expect(res.status).toBe(200);
    // m1 on p1 (down), then m2 on p1 (down, explicit provider tried first), then m2 on p2 (up)
    expect(seen).toEqual(['m1', 'm2', 'm2']);
    expect(seen[seen.length - 1]).toBe('m2'); // upstream got the rewritten model name
    saveSettings({ modelFallbacks: {} });
  });

  it('502s when no fallback is configured', async () => {
    saveSettings({ maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, modelFallbacks: {} });
    vi.stubGlobal('fetch', async () => { throw new Error('down'); });
    const client = mk([{ id: 'a', provider: 'p1' }], [{ id: 'p1', models: ['m1'], baseUrl: 'http://down.invalid/v1' }]);
    await expect(
      client.forward({ method: 'POST', path: '/chat/completions', query: '', headers: {}, bodyText: JSON.stringify({ model: 'm1' }), provider: 'p1' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('does not loop on cyclic fallback config', async () => {
    saveSettings({ maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, modelFallbacks: { 'm1': ['m2'], 'm2': ['m1'] } });
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; throw new Error('down'); });
    const client = mk([{ id: 'a', provider: 'p1' }], [{ id: 'p1', models: ['*'], baseUrl: 'http://down.invalid/v1' }]);
    await expect(
      client.forward({ method: 'POST', path: '/chat/completions', query: '', headers: {}, bodyText: JSON.stringify({ model: 'm1' }), provider: 'p1' }),
    ).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(2); // m1 then m2, then stop — no infinite loop
    saveSettings({ modelFallbacks: {} });
  });
});

describe('error-spike alerts', () => {
  it('errorRate measures the trailing window', () => {
    const metrics = new Metrics();
    metrics.logRequest('sp1', 200, 10, 'm');
    metrics.logRequest('sp1', 502, 10, 'm');
    metrics.logRequest('sp1', 500, 10, 'm');
    const w = metrics.errorRate(60_000);
    expect(w.requests).toBeGreaterThanOrEqual(3);
    expect(w.errors).toBeGreaterThanOrEqual(2);
    expect(w.rate).toBeCloseTo(w.errors / w.requests);
  });

  it('settings round-trip the spike knobs with clamping', () => {
    saveSettings({ errorSpikeThreshold: 0.75, errorSpikeWindowMin: 5, errorSpikeMinRequests: 20 });
    const s = getSettings();
    expect(s.errorSpikeThreshold).toBe(0.75);
    expect(s.errorSpikeWindowMin).toBe(5);
    expect(s.errorSpikeMinRequests).toBe(20);
    saveSettings({ errorSpikeThreshold: 7 });
    expect(getSettings().errorSpikeThreshold).toBe(1); // clamped
    saveSettings({ errorSpikeThreshold: 0.5, errorSpikeWindowMin: 10, errorSpikeMinRequests: 10 });
  });
});
