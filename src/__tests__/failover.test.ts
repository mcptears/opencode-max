import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpstreamClient } from '../upstreamClient.js';
import { AccountPool } from '../accountPool.js';
import { Metrics } from '../metrics.js';
import { ScraperJob } from '../scraperJob.js';
import { saveSettings, getSettings } from '../settings.js';
import type { AccountConfig } from '../config.js';
import type { ProviderConfig } from '../providers.js';

const primary: ProviderConfig = { id: 'primary', name: 'Primary', baseUrl: 'http://primary.invalid/v1', models: ['a*'], enabled: true };
const fallback: ProviderConfig = { id: 'fallback', name: 'Fallback', baseUrl: 'http://fallback.invalid/v1', models: ['*'], enabled: true };
const other: ProviderConfig = { id: 'other', name: 'Other', baseUrl: 'http://other.invalid/v1', models: ['b*'], enabled: true };

const acc = (id: string, provider: string): AccountConfig => ({ id, name: id, provider, apiKey: 'k', priority: 1 });

function makeClient(accounts: AccountConfig[], providers: ProviderConfig[]) {
  const pool = new AccountPool(accounts);
  const rotator = {
    current: () => null,
    dispatcherFor: () => undefined,
    rotate: () => {},
    egressLabel: () => 'direct',
    currentFamily: () => 4,
    setProxies: () => {},
  } as never;
  const sessions = { id: 'ses_test', rotate: () => {} } as never;
  const metrics = new Metrics();
  const client = new UpstreamClient(pool, rotator, sessions, metrics, undefined, () => providers);
  return { client, metrics, rotator };
}

const body = (model: string) => JSON.stringify({ model, messages: [] });

beforeEach(() => {
  saveSettings({ maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1 });
  vi.stubGlobal(
    'fetch',
    async (url: unknown) => {
      const u = String(url);
      if (u.includes('primary.invalid')) throw new Error('connection refused');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cross-provider failover', () => {
  it('fails over to the catch-all provider when the primary is down', async () => {
    const { client, metrics } = makeClient([acc('fb-1', 'fallback')], [primary, fallback]);
    const res = await client.forward({
      method: 'POST',
      path: '/chat/completions',
      query: '',
      headers: {},
      bodyText: body('a-1'),
      provider: 'primary',
      allowAnonymous: true,
    });
    expect(res.status).toBe(200);
    expect(metrics.failovers).toBe(1);
  });

  it('throws 502 when no provider can serve', async () => {
    const { client } = makeClient([], [primary]);
    await expect(
      client.forward({ method: 'POST', path: '/chat/completions', query: '', headers: {}, bodyText: body('a-1'), provider: 'primary', allowAnonymous: true }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('does not fail over to providers that cannot serve the model', async () => {
    const { client, metrics } = makeClient([acc('o-1', 'other')], [primary, other]);
    await expect(
      client.forward({ method: 'POST', path: '/chat/completions', query: '', headers: {}, bodyText: body('a-1'), provider: 'primary', allowAnonymous: true }),
    ).rejects.toMatchObject({ status: 502 });
    expect(metrics.failovers).toBe(0);
  });

  it('does not fail over when the primary succeeds', async () => {
    const { client, metrics } = makeClient([acc('fb-1', 'fallback')], [fallback]);
    const res = await client.forward({
      method: 'POST',
      path: '/chat/completions',
      query: '',
      headers: {},
      bodyText: body('a-1'),
      provider: 'fallback',
    });
    expect(res.status).toBe(200);
    expect(metrics.failovers).toBe(0);
  });
});

describe('ScraperJob', () => {
  it('refuses a second concurrent run', async () => {
    const { metrics, rotator } = makeClient([], []);
    const job = new ScraperJob(rotator as never, metrics);
    expect(job.start(false)).toBe(true);
    expect(job.start(false)).toBe(false);
    expect(job.status().running).toBe(true);
    // let the stubbed (instant-failure) scrape finish
    for (let i = 0; i < 100 && job.status().running; i++) await new Promise((r) => setTimeout(r, 20));
    expect(job.status().running).toBe(false);
    expect(job.status().lastRunAt).toBeGreaterThan(0);
  });
});

describe('auto-scrape settings', () => {
  it('round-trips through saveSettings', () => {
    saveSettings({ autoScrape: true, autoScrapeIntervalHours: 12 });
    const s = getSettings();
    expect(s.autoScrape).toBe(true);
    expect(s.autoScrapeIntervalHours).toBe(12);
    saveSettings({ autoScrape: false });
    expect(getSettings().autoScrape).toBe(false);
  });
});
