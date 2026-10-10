import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountPool } from '../accountPool.js';
import { IpRotator } from '../ipRotator.js';
import { Metrics } from '../metrics.js';
import { SessionManager } from '../sessionManager.js';
import { ScraperJob } from '../scraperJob.js';
import { saveSettings } from '../settings.js';
import { buildAdminRouter } from '../adminRoutes.js';

describe('POST /api/proxies/check', () => {
  let base = '';
  let server: Server | null = null;
  let checkedWith: string[][] = [];
  const auth = { Authorization: 'Bearer ' + 'test' + '-token' };
  // setup.ts already points PROXIES_FILE/ACCOUNTS_FILE at temp files.
  const proxiesFile = process.env.PROXIES_FILE!;
  const accountsFile = process.env.ACCOUNTS_FILE!;

  beforeAll(async () => {
    saveSettings({ adminToken: 'test-token' });
    fs.writeFileSync(proxiesFile, JSON.stringify({ proxies: ['http://a:1111', 'http://b:2222'] }));
    fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [] }));
    const app = express();
    app.use(express.raw({ type: () => true, limit: '25mb' }));
    const rotator = new IpRotator(['http://a:1111', 'http://b:2222']);
    // Stub the network prober — we test routing/filtering, not TCP.
    rotator.checkProxies = async (list: string[]) => {
      checkedWith.push(list);
    };
    const pool = new AccountPool([]);
    const metrics = new Metrics();
    app.use(
      buildAdminRouter({ pool, rotator, sessions: new SessionManager(), metrics, scraper: new ScraperJob(rotator, metrics) }),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server!.close(r));
    saveSettings({ adminToken: '' });
  });

  it('checks only the selected proxies that are in the pool', async () => {
    const r = await fetch(`${base}/api/proxies/check`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ proxies: ['http://a:1111'] }),
    });
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.checked).toBe(1);
    expect(checkedWith[checkedWith.length - 1]).toEqual(['http://a:1111']);
  });

  it('ignores proxies that are not in the pool', async () => {
    const r = await fetch(`${base}/api/proxies/check`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ proxies: ['http://evil:9999'] }),
    });
    const j = await r.json();
    expect(j.checked).toBe(0);
    expect(checkedWith[checkedWith.length - 1]).toEqual([]);
  });

  it('checks all proxies when none are selected', async () => {
    const r = await fetch(`${base}/api/proxies/check`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const j = await r.json();
    expect(j.checked).toBe(2);
    expect(checkedWith[checkedWith.length - 1]).toEqual(['http://a:1111', 'http://b:2222']);
  });
});
