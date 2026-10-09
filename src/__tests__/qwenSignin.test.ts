import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { qwenSignIn, sha256Hex } from '../qwenWeb.js';
import { buildAdminRouter } from '../adminRoutes.js';
import { projectRoot } from '../paths.js';
import { AccountPool } from '../accountPool.js';
import { IpRotator } from '../ipRotator.js';
import { SessionManager } from '../sessionManager.js';
import { Metrics } from '../metrics.js';
import { ScraperJob } from '../scraperJob.js';
import { saveSettings } from '../settings.js';

/** Mock chat.qwen.ai signin endpoints. */
let mock: http.Server | null = null;
let mockBase = '';
let signinMode: 'cookie' | 'json-token' | 'v1-404' | 'bad-creds' = 'cookie';
let lastSigninBody: unknown = null;

beforeAll(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url === '/api/v1/auths/signin' && req.method === 'POST') {
        lastSigninBody = JSON.parse(body);
        if (signinMode === 'bad-creds') {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"invalid credentials"}');
          return;
        }
        if (signinMode === 'v1-404') {
          res.writeHead(404).end('{}');
          return;
        }
        if (signinMode === 'json-token') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":"jwt-from-json"}');
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': ['token=cookie-token-123; Path=/; HttpOnly', 'analytics=xyz; Path=/'],
        }).end('{"token":"jwt-from-json"}');
        return;
      }
      if (url === '/api/v2/auths/signin' && req.method === 'POST') {
        lastSigninBody = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":"jwt-v2"}');
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => mock!.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  signinMode = 'cookie';
});

afterAll(async () => {
  await new Promise((r) => mock!.close(r));
});

describe('qwenSignIn', () => {
  it('hashes match SHA-256', async () => {
    expect(await sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('signs in and prefers the token cookie', async () => {
    signinMode = 'cookie';
    const r = await qwenSignIn(mockBase, 'a@b.c', '0'.repeat(64));
    expect(r).toEqual({ ok: true, credential: 'token=cookie-token-123' });
    // Password must arrive pre-hashed, never plaintext.
    const sent = lastSigninBody as { email: string; password: string };
    expect(sent.email).toBe('a@b.c');
    expect(sent.password).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to the JSON token when no cookie is set', async () => {
    signinMode = 'json-token';
    const r = await qwenSignIn(mockBase, 'a@b.c', '0'.repeat(64));
    expect(r).toEqual({ ok: true, credential: 'token=jwt-from-json' });
    signinMode = 'cookie';
  });

  it('falls back to the v2 endpoint when v1 404s', async () => {
    signinMode = 'v1-404';
    const r = await qwenSignIn(mockBase, 'a@b.c', '0'.repeat(64));
    expect(r).toEqual({ ok: true, credential: 'token=jwt-v2' });
    signinMode = 'cookie';
  });

  it('reports bad credentials clearly', async () => {
    signinMode = 'bad-creds';
    const r = await qwenSignIn(mockBase, 'a@b.c', '0'.repeat(64));
    expect(r).toEqual({ ok: false, error: 'email or password incorrect' });
    signinMode = 'cookie';
  });
});

describe('POST /api/accounts/qwen-login', () => {
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
    // Point the qwen provider at the mock instead of real chat.qwen.ai.
    const pr = await fetch(`${base}/api/providers`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'qwen', name: 'Qwen', baseUrl: mockBase, models: ['qwen*'], protocol: 'qwen-web', qwen: { defaultModel: 'qwen3.7-plus' } }),
    });
    if (pr.status !== 201) throw new Error('could not create qwen provider: ' + (await pr.text()));
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server!.close(r));
    saveSettings({ adminToken: '' });
    try { fs.unlinkSync(providersFile); } catch { /* ignore */ }
  });

  it('rejects bad input', async () => {
    const badEmail = await fetch(`${base}/api/accounts/qwen-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', passwordHash: '0'.repeat(64) }),
    });
    expect(badEmail.status).toBe(400);
    const noPass = await fetch(`${base}/api/accounts/qwen-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    expect(noPass.status).toBe(400);
  });

  it('signs in, creates the provider and the account', async () => {
    signinMode = 'cookie';
    const password = 's3cret!';
    const expectedHash = createHash('sha256').update(password).digest('hex');
    const r = await fetch(`${base}/api/accounts/qwen-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      // Send the PLAINTEXT password — the server must hash it, never store it.
      body: JSON.stringify({ email: 'user@example.com', password, name: 'Qwen main' }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { ok: boolean; id: string };
    expect(j.ok).toBe(true);
    // Server forwarded the hash, not the plaintext.
    expect((lastSigninBody as { password: string }).password).toBe(expectedHash);
    // Account persisted with the session credential — and no password anywhere.
    const stored = JSON.parse(fs.readFileSync(accountsFile, 'utf8')) as { accounts: Record<string, unknown>[] };
    const acc = stored.accounts.find((a) => a.id === j.id)!;
    expect(acc.apiKey).toBe('token=cookie-token-123');
    expect(JSON.stringify(stored)).not.toContain(password);
    expect(JSON.stringify(stored)).not.toContain(expectedHash);
  });

  it('surfaces sign-in failures without creating an account', async () => {
    signinMode = 'bad-creds';
    const before = (JSON.parse(fs.readFileSync(accountsFile, 'utf8')) as { accounts: unknown[] }).accounts.length;
    const r = await fetch(`${base}/api/accounts/qwen-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', passwordHash: '1'.repeat(64) }),
    });
    const j = (await r.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe('email or password incorrect');
    const after = (JSON.parse(fs.readFileSync(accountsFile, 'utf8')) as { accounts: unknown[] }).accounts.length;
    expect(after).toBe(before);
    signinMode = 'cookie';
  });
});
