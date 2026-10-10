import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountPool } from '../accountPool.js';
import { IpRotator } from '../ipRotator.js';
import { Metrics } from '../metrics.js';
import { SessionManager } from '../sessionManager.js';
import { ScraperJob } from '../scraperJob.js';
import { saveSettings } from '../settings.js';
import { projectRoot } from '../paths.js';
import { buildAdminRouter } from '../adminRoutes.js';

describe('POST /api/accounts auto-creates the qwen provider', () => {
  let base = '';
  let server: Server | null = null;
  const auth = { Authorization: 'Bearer ' + 'test' + '-token' };
  const accountsFile = process.env.ACCOUNTS_FILE!;
  // providers.json has no env override — clean up anything the test writes.
  const providersFile = path.join(projectRoot(), 'providers.json');

  beforeAll(async () => {
    saveSettings({ adminToken: 'test-token' });
    fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [] }));
    try { fs.unlinkSync(providersFile); } catch { /* ignore */ }
    const app = express();
    app.use(express.raw({ type: () => true, limit: '25mb' }));
    const pool = new AccountPool([]);
    const rotator = new IpRotator([]);
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
    try { fs.unlinkSync(providersFile); } catch { /* ignore */ }
  });

  it('adds the native qwen preset when a qwen account is created without it', async () => {
    const r = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'qwen-9', name: 'Qwen', provider: 'qwen', apiKey: 'tok', priority: 1 }),
    });
    expect(r.status).toBe(201);
    const providers = await (await fetch(`${base}/api/providers`, { headers: auth })).json();
    const qwen = (providers.providers as { id: string; protocol: string }[]).find((p) => p.id === 'qwen');
    expect(qwen).toBeDefined();
    expect(qwen!.protocol).toBe('qwen-web');
  });

  it('does not duplicate the provider when it already exists', async () => {
    const r = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'qwen-10', name: 'Qwen 2', provider: 'qwen', apiKey: 'tok', priority: 2 }),
    });
    expect(r.status).toBe(201);
    const providers = await (await fetch(`${base}/api/providers`, { headers: auth })).json();
    const count = (providers.providers as { id: string }[]).filter((p) => p.id === 'qwen').length;
    expect(count).toBe(1);
  });
});
