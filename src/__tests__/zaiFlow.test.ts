import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { validateZaiCredential, zaiChatCompletion } from '../zaiWeb.js';
import { buildAdminRouter } from '../adminRoutes.js';
import { projectRoot } from '../paths.js';
import { AccountPool } from '../accountPool.js';
import { IpRotator } from '../ipRotator.js';
import { SessionManager } from '../sessionManager.js';
import { Metrics } from '../metrics.js';
import { ScraperJob } from '../scraperJob.js';
import { saveSettings } from '../settings.js';

function makeToken(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64(payload)}.sig`;
}
const TOKEN = makeToken({ id: 'user-1', email: 'me@example.com' });

/** Mock chat.z.ai. */
let mock: http.Server | null = null;
let mockBase = '';
let lastChatQuery = '';
let lastChatHeaders: Record<string, string> = {};
let lastChatBody: unknown = null;

beforeAll(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const json = (o: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      };
      if (url === '/api/v1/auths/' && req.method === 'GET') {
        if (req.headers.authorization === `Bearer ${TOKEN}`) {
          json({ token: TOKEN });
        } else {
          json({ code: 401, msg: 'unauthorized' }, 401);
        }
        return;
      }
      if (url.startsWith('/api/v2/chat/completions') && req.method === 'POST') {
        lastChatQuery = url.split('?')[1] ?? '';
        lastChatHeaders = { 'x-signature': String(req.headers['x-signature'] ?? ''), 'x-fe-version': String(req.headers['x-fe-version'] ?? '') };
        lastChatBody = JSON.parse(body);
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          json({ code: 401, msg: 'unauthorized' }, 401);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frames = [
          { data: { delta_content: '<details type="think"><summary>Thinking</summary>Let me think' } },
          { data: { delta_content: ' about this</details>Hello' } },
          { data: { delta_content: ' world' } },
          { data: { phase: 'done' } },
        ];
        for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
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

describe('validateZaiCredential', () => {
  it('accepts a live token and decodes the identity', async () => {
    const r = await validateZaiCredential(mockBase, TOKEN);
    expect(r).toEqual({ ok: true, id: 'user-1', email: 'me@example.com' });
  });

  it('rejects a dead token', async () => {
    const r = await validateZaiCredential(mockBase, 'dead');
    expect(r.ok).toBe(false);
  });
});

describe('zaiChatCompletion', () => {
  it('streams OpenAI chunks with reasoning_content', async () => {
    const stream = await zaiChatCompletion({
      baseUrl: mockBase,
      credential: TOKEN,
      model: 'glm-5',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      responseModel: 'glm-5',
    });
    const text = await new Response(stream).text();
    // Signed request parts.
    expect(lastChatQuery).toContain('signature_timestamp=');
    expect(lastChatQuery).toContain('user_id=user-1');
    expect(lastChatHeaders['x-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect((lastChatBody as { model: string }).model).toBe('glm-5');
    expect((lastChatBody as { features: { enable_thinking: boolean } }).features.enable_thinking).toBe(true);
    // Translated chunks.
    expect(text).toContain('reasoning_content');
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('data: [DONE]');
  });

  it('returns a single JSON completion when stream=false', async () => {
    const stream = await zaiChatCompletion({
      baseUrl: mockBase,
      credential: TOKEN,
      model: 'glm-5',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      responseModel: 'glm-5',
    });
    const j = JSON.parse(await new Response(stream).text());
    expect(j.object).toBe('chat.completion');
    expect(j.model).toBe('glm-5');
    expect(j.choices[0].message.content).toContain('Hello world');
    expect(j.choices[0].message.reasoning_content).toContain('Let me think');
  });

  it('rejects an invalid token', async () => {
    await expect(
      zaiChatCompletion({ baseUrl: mockBase, credential: 'nope', model: 'glm-5', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    ).rejects.toThrow();
  });

  it('rejects an empty prompt', async () => {
    await expect(
      zaiChatCompletion({ baseUrl: mockBase, credential: TOKEN, model: 'glm-5', messages: [], stream: true }),
    ).rejects.toThrow(/empty prompt/);
  });
});

describe('Z.ai admin endpoints', () => {
  let base = '';
  let server: Server | null = null;
  const auth = { Authorization: 'Bearer ' + 'test' + '-token' };
  const accountsFile = process.env.ACCOUNTS_FILE!;
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

  it('preset endpoint adds the z.ai provider, 409 when present', async () => {
    const r1 = await fetch(`${base}/api/providers/preset/zai`, { method: 'POST', headers: auth });
    expect(r1.status).toBe(201);
    const r2 = await fetch(`${base}/api/providers/preset/zai`, { method: 'POST', headers: auth });
    expect(r2.status).toBe(409);
    try { fs.unlinkSync(providersFile); } catch { /* ignore */ }
  });

  it('validates a live token against the mock', async () => {
    const ok = await (
      await fetch(`${base}/api/accounts/validate-zai`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ credential: TOKEN, baseUrl: mockBase }),
      })
    ).json();
    expect(ok).toEqual({ ok: true, id: 'user-1', email: 'me@example.com' });
  });

  it('rejects a dead token', async () => {
    const bad = await (
      await fetch(`${base}/api/accounts/validate-zai`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'dead', baseUrl: mockBase }),
      })
    ).json();
    expect(bad.ok).toBe(false);
  });

  it('provider Test probes the z.ai credential', async () => {
    // Create the provider pointed at the mock, plus an account holding the token.
    const pr = await fetch(`${base}/api/providers`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'zai', name: 'Z.ai', baseUrl: mockBase, models: ['glm*'], protocol: 'zai-web', zai: { defaultModel: 'glm-5' } }),
    });
    expect(pr.status).toBe(201);
    const ar = await fetch(`${base}/api/accounts`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'zai-1', name: 'Z.ai main', provider: 'zai', apiKey: TOKEN, priority: 1 }),
    });
    expect(ar.status).toBe(201);
    const t = await (
      await fetch(`${base}/api/providers/zai/test`, { method: 'POST', headers: auth })
    ).json();
    expect(t.ok).toBe(true);
  });
});
