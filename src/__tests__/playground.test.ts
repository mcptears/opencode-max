import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRouter } from '../routes.js';
import { buildAdminRouter } from '../adminRoutes.js';
import { AccountPool } from '../accountPool.js';
import { SessionManager } from '../sessionManager.js';
import { Metrics } from '../metrics.js';
import { ScraperJob } from '../scraperJob.js';
import { saveSettings } from '../settings.js';
import type { AccountConfig } from '../config.js';
import type { ProviderConfig } from '../providers.js';

const provider: ProviderConfig = {
  id: 'mock',
  name: 'Mock',
  baseUrl: 'http://mock.invalid/v1',
  models: ['*'],
  enabled: true,
};
const account: AccountConfig = { id: 'a1', name: 'a1', provider: 'mock', apiKey: 'k', priority: 1 };

let base = '';
let server: Server | null = null;
const auth = { Authorization: 'Bearer ' + 'test' + '-token' };

const sseBody =
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

beforeAll(async () => {
  saveSettings({ adminToken: 'test-token', clientTokens: [] });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: unknown, init?: unknown) => {
    // Only stub the upstream; let the test's own HTTP calls through.
    if (String(url).includes('mock.invalid')) {
      return new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return realFetch(url as string, init as RequestInit);
  });
  const app = express();
  app.use(express.raw({ type: () => true, limit: '25mb' }));
  const pool = new AccountPool([account]);
  const rotator = {
    current: () => null,
    dispatcherFor: () => undefined,
    rotate: () => {},
    egressLabel: () => 'direct',
    currentFamily: () => 4,
    setProxies: () => {},
  } as never;
  const sessions = new SessionManager();
  const metrics = new Metrics();
  app.use(buildAdminRouter({ pool, rotator, sessions, metrics, scraper: new ScraperJob(rotator, metrics) }));
  app.use(buildRouter(pool, rotator, sessions, metrics, undefined, () => [provider], undefined));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  saveSettings({ adminToken: '' });
  if (server) await new Promise((r) => server!.close(r));
});

describe('POST /api/playground/chat', () => {
  it('rejects a missing model with 400', async () => {
    const r = await fetch(`${base}/api/playground/chat`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(r.status).toBe(400);
  });

  it('streams an OpenAI SSE reply through the upstream pipeline', async () => {
    const r = await fetch(`${base}/api/playground/chat`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('data: [DONE]');
  });

  it('requires admin auth when an admin token is configured', async () => {
    const r = await fetch(`${base}/api/playground/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [] }),
    });
    expect(r.status).toBe(401);
  });
});
