import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildAdminRouter } from '../adminRoutes.js';
import { AccountPool } from '../accountPool.js';
import { IpRotator } from '../ipRotator.js';
import { SessionManager } from '../sessionManager.js';
import { Metrics } from '../metrics.js';
import { ScraperJob } from '../scraperJob.js';
import { saveSettings } from '../settings.js';
import { projectRoot } from '../paths.js';

let base = '';
let server: Server | null = null;
const auth = { Authorization: 'Bearer test-token' };
// providers.json has no env override — clean up anything the restore writes.
const providersFile = path.join(projectRoot(), 'providers.json');

beforeAll(async () => {
  saveSettings({ adminToken: 'test-token' });
  const app = express();
  app.use(express.raw({ type: () => true, limit: '25mb' }));
  const pool = new AccountPool([{ id: 'a1', name: 'a1', provider: 'zen', apiKey: 'k1', priority: 1 }]);
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
  try {
    if (fs.existsSync(providersFile)) fs.unlinkSync(providersFile);
  } catch {
    /* ignore */
  }
});

const postRestore = (payload: unknown) =>
  fetch(`${base}/api/backup/restore`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

describe('backup/restore', () => {
  it('requires auth for GET /api/backup even though it is a GET', async () => {
    expect((await fetch(`${base}/api/backup`)).status).toBe(401);
    const r = await fetch(`${base}/api/backup`, { headers: auth });
    expect(r.status).toBe(200);
    const data = (await r.json()) as Record<string, unknown>;
    expect(data.version).toBe(1);
    expect(Array.isArray(data.accounts)).toBe(true);
    expect(Array.isArray(data.providers)).toBe(true);
    expect(Array.isArray(data.scraperProviders)).toBe(true);
    expect(typeof data.settings).toBe('object');
  });

  it('rejects invalid restore payloads without applying anything', async () => {
    const r = await postRestore({ accounts: [{ id: 'x' }] }); // missing provider/apiKey
    expect(r.status).toBe(400);
    const r2 = await postRestore({ providers: [{ id: 'p' }] }); // missing baseUrl
    expect(r2.status).toBe(400);
  });

  it('restores accounts, providers and settings live', async () => {
    const r = await postRestore({
      accounts: [{ id: 'b1', name: 'b1', provider: 'zen', apiKey: 'k2', priority: 1 }],
      providers: [{ id: 'zen', name: 'Zen', baseUrl: 'https://opencode.ai/zen/v1', models: ['*'], enabled: true }],
      settings: { maxRetries: 2 },
    });
    expect(r.status).toBe(200);
    const st = (await (await fetch(`${base}/api/accounts`, { headers: auth })).json()) as {
      accounts: { id: string }[];
    };
    expect(st.accounts.map((a) => a.id)).toContain('b1');
    const pv = (await (await fetch(`${base}/api/providers`, { headers: auth })).json()) as {
      providers: { id: string }[];
    };
    expect(pv.providers.map((p) => p.id)).toContain('zen');
  });
});
