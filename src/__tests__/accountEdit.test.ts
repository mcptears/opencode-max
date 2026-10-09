import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildAdminRouter } from '../adminRoutes.js';
import { AccountPool } from '../accountPool.js';
import { IpRotator } from '../ipRotator.js';
import { SessionManager } from '../sessionManager.js';
import { Metrics } from '../metrics.js';
import { ScraperJob } from '../scraperJob.js';
import { saveSettings } from '../settings.js';
import { QuotaTracker } from '../quota.js';

let base = '';
let server: Server | null = null;
const auth = { Authorization: 'Bearer ' + 'test' + '-token' };
const accountsFile = process.env.ACCOUNTS_FILE!;

const readAccountsFile = () =>
  (JSON.parse(fs.readFileSync(accountsFile, 'utf8')) as { accounts: Record<string, unknown>[] }).accounts;

beforeAll(async () => {
  saveSettings({ adminToken: 'test-token' });
  fs.writeFileSync(accountsFile, JSON.stringify([{ id: 'k1', name: 'K1', provider: 'zen', apiKey: 'secret1', priority: 1 }]));
  const app = express();
  app.use(express.raw({ type: () => true, limit: '25mb' }));
  const pool = new AccountPool([{ id: 'k1', name: 'K1', provider: 'zen', apiKey: 'secret1', priority: 1 }]);
  const rotator = new IpRotator([]);
  const metrics = new Metrics();
  app.use(
    buildAdminRouter({ pool, rotator, sessions: new SessionManager(), metrics, scraper: new ScraperJob(rotator, metrics) }),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server!.close(r));
  saveSettings({ adminToken: '' });
});

const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('account management', () => {
  it('allows creating a keyless account', async () => {
    const r = await post('/api/accounts', { id: 'k2', name: 'K2', provider: 'zen', apiKey: '', priority: 2 });
    expect(r.status).toBe(201);
    const stored = readAccountsFile().find((a) => a.id === 'k2');
    expect(stored?.apiKey).toBe('');
  });

  it('stores per-account cooldownPeriod, baseUrl and quotaLimit', async () => {
    const r = await post('/api/accounts', {
      id: 'k3', name: 'K3', provider: 'zen', apiKey: 's3', priority: 3,
      cooldownPeriod: 60000, baseUrl: 'http://custom.invalid/v1', quotaLimit: 50,
    });
    expect(r.status).toBe(201);
    const stored = readAccountsFile().find((a) => a.id === 'k3')!;
    expect(stored.cooldownPeriod).toBe(60000);
    expect(stored.baseUrl).toBe('http://custom.invalid/v1');
    expect(stored.quotaLimit).toBe(50);
  });

  it('PUT with empty apiKey keeps the existing key', async () => {
    const r = await put('/api/accounts/k1', { name: 'K1-renamed', provider: 'zen', apiKey: '', priority: 1 });
    expect(r.status).toBe(200);
    const stored = readAccountsFile().find((a) => a.id === 'k1')!;
    expect(stored.apiKey).toBe('secret1');
    expect(stored.name).toBe('K1-renamed');
  });

  it('PUT with clearApiKey makes the account keyless', async () => {
    const r = await put('/api/accounts/k1', { name: 'K1', provider: 'zen', apiKey: '', clearApiKey: true, priority: 1 });
    expect(r.status).toBe(200);
    const stored = readAccountsFile().find((a) => a.id === 'k1')!;
    expect(stored.apiKey).toBe('');
  });

  it('PUT can set a new key', async () => {
    const r = await put('/api/accounts/k2', { name: 'K2', provider: 'zen', apiKey: 'newsecret', priority: 2 });
    expect(r.status).toBe(200);
    expect(readAccountsFile().find((a) => a.id === 'k2')?.apiKey).toBe('newsecret');
  });
});

describe('per-account quota', () => {
  it('limitFor prefers the per-account override', () => {
    saveSettings({ quota5hLimit: 200 });
    const q = new QuotaTracker();
    expect(q.limitFor(undefined)).toBe(200);
    expect(q.limitFor(50)).toBe(50);
    expect(q.isOverQuota('nobody', 50)).toBe(false);
  });
});
