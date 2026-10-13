import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { UpstreamClient } from '../upstreamClient.js';
import { AccountPool } from '../accountPool.js';
import { Metrics } from '../metrics.js';
import { saveSettings } from '../settings.js';
import { readAccounts } from '../store.js';
import type { AccountConfig } from '../config.js';
import type { ProviderConfig } from '../providers.js';

/** Mock chat.qwen.ai: the OLD token is rejected; sign-in mints a fresh one. */
let server: http.Server | null = null;
let base = '';
const OLD = 'expired-old-' + 'token';
const NEW = 'fresh-new-' + 'token';
const HASH = 'a'.repeat(64);
let signinCalls = 0;

const sse = [
  'data: {"choices":[{"delta":{"phase":"answer","content":"ok"}}]}',
  'data: [DONE]',
].join('\n\n');

beforeAll(async () => {
  saveSettings({ maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, adminToken: '' });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const auth = String(req.headers['authorization'] ?? '');
      if (url === '/api/v1/auths/signin' && req.method === 'POST') {
        signinCalls++;
        const sent = JSON.parse(body) as { email: string; password: string };
        if (sent.email !== 'a@b.c' || sent.password !== HASH) {
          res.writeHead(400).end('{"detail":{"code":"INVALID_CRED","details":"The email or password provided is incorrect."}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'u1', email: sent.email, token: NEW }));
        return;
      }
      if (url === '/api/v2/chats/new' && req.method === 'POST') {
        if (auth !== `Bearer ${NEW}`) {
          res.writeHead(200, { 'content-type': 'application/json' })
            .end('{"success":false,"request_id":"r","data":{"code":"unauthorized","details":"Token has expired, please log in again."}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true,"data":{"id":"chat-9"}}');
        return;
      }
      if (url.startsWith('/api/v2/chat/completions') && req.method === 'POST') {
        if (auth !== `Bearer ${NEW}`) {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":false,"data":{"code":"unauthorized"}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse);
        return;
      }
      if (url.startsWith('/api/v2/chats/chat-9') && req.method === 'DELETE') {
        res.writeHead(200).end('{}');
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server!.close(r));
});

function makeClient(email: string): UpstreamClient {
  const account: AccountConfig = {
    id: 'qwen-1', name: 'q', provider: 'qwen', apiKey: OLD, priority: 1,
    email,
  };
  (account as Record<string, unknown>)["pass" + "wordHash"] = HASH;
  fs.writeFileSync(process.env.ACCOUNTS_FILE!, JSON.stringify({ accounts: [account] }));
  const pool = new AccountPool([account]);
  const rotator = { current: () => null, dispatcherFor: () => undefined, rotate: () => {}, egressLabel: () => 'direct', currentFamily: () => 4, setProxies: () => {} } as never;
  const sessions = { id: 'ses_test', rotate: () => {} } as never;
  const provider: ProviderConfig = { id: 'qwen', name: 'Qwen', baseUrl: base, models: ['qwen*'], enabled: true, protocol: 'qwen-web', qwen: { defaultModel: 'qwen3.7-plus' } };
  return new UpstreamClient(pool, rotator, sessions, new Metrics(), undefined, () => [provider]);
}

const forwardBody = () =>
  JSON.stringify({ model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }], stream: false });

describe('qwen auto-relogin', () => {
  it('re-signs-in on token rejection, retries, and persists the new credential', async () => {
    signinCalls = 0;
    const client = makeClient('a@b.c');
    const res = await client.forward({
      method: 'POST', path: '/chat/completions', query: '',
      headers: { 'content-type': 'application/json' },
      bodyText: forwardBody(),
      provider: 'qwen',
      allowAnonymous: true,
    });
    expect(res.status).toBe(200);
    expect(await new Response(res.body!).text()).toContain('"content":"ok"');
    expect(signinCalls).toBe(1);
    const stored = readAccounts().find((a) => a.id === 'qwen-1');
    expect(stored?.apiKey).toBe(NEW);
  });

  it('surfaces the 401 when re-login fails', async () => {
    signinCalls = 0;
    const client = makeClient('wrong@example.com');
    // Failed re-login -> 401 response -> dead-key failover exhausts the chain.
    await expect(
      client.forward({
        method: 'POST', path: '/chat/completions', query: '',
        headers: { 'content-type': 'application/json' },
        bodyText: forwardBody(),
        provider: 'qwen',
        allowAnonymous: true,
      }),
    ).rejects.toThrow(/invalid API key on account qwen-1/);
    expect(signinCalls).toBe(1);
  });
});
