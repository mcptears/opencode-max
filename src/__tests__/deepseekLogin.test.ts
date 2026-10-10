import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { deepseekSignIn, resendDeepSeekCode } from '../deepseekWeb.js';
import { buildAdminRouter } from '../adminRoutes.js';
import { projectRoot } from '../paths.js';
import { AccountPool } from '../accountPool.js';
import { IpRotator } from '../ipRotator.js';
import { SessionManager } from '../sessionManager.js';
import { Metrics } from '../metrics.js';
import { ScraperJob } from '../scraperJob.js';
import { saveSettings } from '../settings.js';

/** Mock chat.deepseek.com auth + session endpoints. */
let mock: http.Server | null = null;
let mockBase = '';
let loginMode: 'ok' | 'bad-creds' | 'verify' = 'ok';
let lastLoginBody: unknown = null;
let lastResendBody: unknown = null;
let sessionMode: 'ok' | 'dead' = 'ok';

beforeAll(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const json = (o: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      };
      if (url === '/api/v0/users/login' && req.method === 'POST') {
        lastLoginBody = JSON.parse(body);
        if (loginMode === 'bad-creds') {
          json({ code: 400, msg: 'invalid', data: { biz_code: 400, biz_msg: 'email or password incorrect', biz_data: {} } }, 401);
          return;
        }
        if (loginMode === 'verify') {
          const b = lastLoginBody as { verification_code?: string };
          if (b.verification_code === '123456') {
            json({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { user: { token: 'ds-token-123', email: 'u***@example.com' } } } });
            return;
          }
          json({ code: 0, msg: '', data: { biz_code: 1001, biz_msg: 'please verify your email — a verification code was sent', biz_data: {} } });
          return;
        }
        json({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { user: { token: 'ds-token-123', email: 'u***@example.com' } } } });
        return;
      }
      if (url === '/api/v0/users/create_email_verification_code' && req.method === 'POST') {
        lastResendBody = JSON.parse(body);
        json({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: {} } });
        return;
      }
      if (url === '/api/v0/chat_session/create' && req.method === 'POST') {
        if (sessionMode === 'dead') {
          json({ code: 40003, msg: 'Authorization Failed (invalid token)', data: {} });
          return;
        }
        json({ code: 0, data: { biz_code: 0, biz_data: { chat_session: { id: 'sess-9' } } } });
        return;
      }
      if (url === '/api/v0/chat_session/delete' && req.method === 'POST') {
        json({ code: 0, data: { biz_code: 0, biz_data: {} } });
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => mock!.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => mock!.close(r));
});

describe('deepseekSignIn', () => {
  it('signs in and returns the user token', async () => {
    loginMode = 'ok';
    const r = await deepseekSignIn(mockBase, 'u@example.com', '0'.repeat(64));
    expect(r).toEqual({ ok: true, credential: 'ds-token-123' });
    const sent = lastLoginBody as { email: string; password: string; os: string; device_id: string; mobile: string };
    expect(sent.email).toBe('u@example.com');
    expect(sent.password).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.os).toBe('web');
    expect(sent.mobile).toBe('');
    expect(typeof sent.device_id).toBe('string');
  });

  it('reports bad credentials clearly', async () => {
    loginMode = 'bad-creds';
    const r = await deepseekSignIn(mockBase, 'u@example.com', '0'.repeat(64));
    expect(r).toEqual({ ok: false, error: 'email or password incorrect' });
    loginMode = 'ok';
  });

  it('returns needCode when DeepSeek asks for email verification', async () => {
    loginMode = 'verify';
    const r = await deepseekSignIn(mockBase, 'u@example.com', '0'.repeat(64));
    expect(r.ok).toBe(false);
    expect((r as { needCode?: boolean }).needCode).toBe(true);
    loginMode = 'ok';
  });

  it('completes the login when the verification code is supplied', async () => {
    loginMode = 'verify';
    const r = await deepseekSignIn(mockBase, 'u@example.com', '0'.repeat(64), { verificationCode: '123456' });
    expect(r).toEqual({ ok: true, credential: 'ds-token-123' });
    const sent = lastLoginBody as { verification_code?: string; verify_code?: string; code?: string };
    expect(sent.verification_code).toBe('123456');
    loginMode = 'ok';
  });

  it('resends the verification code', async () => {
    const r = await resendDeepSeekCode(mockBase, 'u@example.com');
    expect(r).toEqual({ ok: true });
    const sent = lastResendBody as { email?: string; scenario?: string };
    expect(sent.email).toBe('u@example.com');
    expect(sent.scenario).toBe('login');
  });
});

describe('DeepSeek admin endpoints', () => {
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
    // Point the deepseek provider at the mock instead of real chat.deepseek.com.
    const pr = await fetch(`${base}/api/providers`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'deepseek', name: 'DeepSeek', baseUrl: mockBase, models: ['deepseek*'], protocol: 'deepseek-web', deepseek: { defaultModel: 'deepseek-chat', thinkingEnabled: true } }),
    });
    if (pr.status !== 201) throw new Error('could not create deepseek provider: ' + (await pr.text()));
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server!.close(r));
    saveSettings({ adminToken: '' });
    try { fs.unlinkSync(providersFile); } catch { /* ignore */ }
  });

  /** (Re)create the deepseek provider pointing at the mock, regardless of test order. */
  async function ensureMockProvider(): Promise<void> {
    try { fs.unlinkSync(providersFile); } catch { /* ignore */ }
    const pr = await fetch(`${base}/api/providers`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'deepseek', name: 'DeepSeek', baseUrl: mockBase, models: ['deepseek*'], protocol: 'deepseek-web', deepseek: { defaultModel: 'deepseek-chat', thinkingEnabled: true } }),
    });
    if (pr.status !== 201) throw new Error('could not create deepseek provider: ' + (await pr.text()));
  }

  it('rejects bad input', async () => {
    const badEmail = await fetch(`${base}/api/accounts/deepseek-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', passwordHash: '0'.repeat(64) }),
    });
    expect(badEmail.status).toBe(400);
    const noPass = await fetch(`${base}/api/accounts/deepseek-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    expect(noPass.status).toBe(400);
    const noCred = await fetch(`${base}/api/accounts/validate-deepseek`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noCred.status).toBe(400);
  });

  it('validates a live token and rejects a dead one', async () => {
    sessionMode = 'ok';
    const ok = await (
      await fetch(`${base}/api/accounts/validate-deepseek`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'ds-token-123', baseUrl: mockBase }),
      })
    ).json();
    expect(ok).toEqual({ ok: true });
    sessionMode = 'dead';
    const dead = await (
      await fetch(`${base}/api/accounts/validate-deepseek`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'stale', baseUrl: mockBase }),
      })
    ).json();
    expect(dead.ok).toBe(false);
    expect(dead.error).toMatch(/sign in again/);
    sessionMode = 'ok';
  });

  it('signs in and creates the account (provider already exists)', async () => {
    await ensureMockProvider();
    const password = 's3cret!';
    const expectedHash = createHash('sha256').update(password).digest('hex');
    const r = await fetch(`${base}/api/accounts/deepseek-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      // Send the PLAINTEXT password — the server must hash it, never store it.
      body: JSON.stringify({ email: 'user@example.com', password, name: 'DS main' }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { ok: boolean; id: string };
    expect(j.ok).toBe(true);
    expect(j.id).toBe('deepseek-1');
    // Server forwarded the hash, not the plaintext.
    expect((lastLoginBody as { password: string }).password).toBe(expectedHash);
    // Account persisted with the session token — and no password anywhere.
    const stored = JSON.parse(fs.readFileSync(accountsFile, 'utf8')) as { accounts: Record<string, unknown>[] };
    const acc = stored.accounts.find((a) => a.id === j.id)!;
    expect(acc.apiKey).toBe('ds-token-123');
    expect(acc.provider).toBe('deepseek');
    expect(JSON.stringify(stored)).not.toContain(password);
    expect(JSON.stringify(stored)).not.toContain(expectedHash);
  });

  it('auto-creates the provider on sign-in when missing', async () => {
    try { fs.unlinkSync(providersFile); } catch { /* ignore */ }
    // The fresh preset points at real chat.deepseek.com, so the login itself
    // fails here — but the provider must be created before the attempt.
    const r = await fetch(`${base}/api/accounts/deepseek-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'third@example.com', passwordHash: '3'.repeat(64) }),
    });
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(false);
    const providers = JSON.parse(fs.readFileSync(providersFile, 'utf8')) as { providers: { id: string; protocol: string }[] };
    const ds = providers.providers.find((p) => p.id === 'deepseek');
    expect(ds?.protocol).toBe('deepseek-web');
  });

  it('passes the verification challenge through to the dashboard', async () => {
    await ensureMockProvider();
    loginMode = 'verify';
    const r = await fetch(`${base}/api/accounts/deepseek-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', passwordHash: '0'.repeat(64) }),
    });
    const j = (await r.json()) as { ok: boolean; needCode?: boolean; message?: string };
    expect(j.ok).toBe(false);
    expect(j.needCode).toBe(true);
    expect(typeof j.message).toBe('string');
    loginMode = 'ok';
  });

  it('creates the account when the verification code is supplied', async () => {
    await ensureMockProvider();
    loginMode = 'verify';
    const r = await fetch(`${base}/api/accounts/deepseek-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', passwordHash: '0'.repeat(64), verificationCode: '123456' }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { ok: boolean; id: string };
    expect(j.ok).toBe(true);
    loginMode = 'ok';
  });

  it('resend-code endpoint reaches DeepSeek', async () => {
    await ensureMockProvider();
    const r = await fetch(`${base}/api/accounts/deepseek-resend-code`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
    expect((lastResendBody as { email?: string }).email).toBe('user@example.com');
  });

  it('preset endpoint adds the provider, 409 when present', async () => {
    try { fs.unlinkSync(providersFile); } catch { /* ignore */ }
    const r1 = await fetch(`${base}/api/providers/preset/deepseek`, { method: 'POST', headers: auth });
    expect(r1.status).toBe(201);
    const r2 = await fetch(`${base}/api/providers/preset/deepseek`, { method: 'POST', headers: auth });
    expect(r2.status).toBe(409);
  });

  it('surfaces sign-in failures without creating an account', async () => {
    await ensureMockProvider();
    loginMode = 'bad-creds';
    const before = (JSON.parse(fs.readFileSync(accountsFile, 'utf8')) as { accounts: unknown[] }).accounts.length;
    const r = await fetch(`${base}/api/accounts/deepseek-login`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', passwordHash: '1'.repeat(64) }),
    });
    const j = (await r.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe('email or password incorrect');
    const after = (JSON.parse(fs.readFileSync(accountsFile, 'utf8')) as { accounts: unknown[] }).accounts.length;
    expect(after).toBe(before);
    loginMode = 'ok';
  });
});
