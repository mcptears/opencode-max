/** Debug: trace the relogin path outside vitest. */
import http from 'node:http';
import { UpstreamClient } from '../src/upstreamClient.js';
import { AccountPool } from '../src/accountPool.js';
import { Metrics } from '../src/metrics.js';

const OLD = 'expired-old-token';
const NEW = 'fresh-new-token';
const HASH = 'a'.repeat(64);
let signinCalls = 0;

const sse = 'data: {"choices":[{"delta":{"phase":"answer","content":"ok"}}]}\n\ndata: [DONE]\n\n';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url ?? '';
    const auth = String(req.headers['authorization'] ?? '');
    console.log('MOCK', req.method, url, '| auth:', auth.slice(0, 24));
    if (url === '/api/v1/auths/signin' && req.method === 'POST') {
      signinCalls++;
      const sent = JSON.parse(body);
      console.log('MOCK signin body email:', sent.email, '| pw len:', sent.password?.length, '| matches HASH:', sent.password === HASH);
      if (sent.email !== 'a@b.c' || sent.password !== HASH) {
        res.writeHead(400).end('{"detail":{"code":"INVALID_CRED"}}');
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const account = { id: 'qwen-1', name: 'q', provider: 'qwen', apiKey: OLD, priority: 1, email: 'a@b.c' };
account.passwordHash = HASH;
const pool = new AccountPool([account]);
const rotator = { current: () => null, dispatcherFor: () => undefined, rotate: () => {}, egressLabel: () => 'direct', currentFamily: () => 4, setProxies: () => {} };
const sessions = { id: 'ses_test', rotate: () => {} };
const provider = { id: 'qwen', name: 'Qwen', baseUrl: base, models: ['qwen*'], enabled: true, protocol: 'qwen-web', qwen: { defaultModel: 'qwen3.7-plus' } };
const metrics = new Metrics();
metrics.record = (kind, detail) => console.log('METRIC', kind, '|', detail);
const client = new UpstreamClient(pool, rotator, sessions, metrics, undefined, () => [provider]);

const origRefresh = client.refreshQwenCredential.bind(client);
client.refreshQwenCredential = async (p, a) => {
  console.log('REFRESH CALLED for', a.id, '| email:', a.email, '| hash set:', !!a.passwordHash);
  const r = await origRefresh(p, a);
  console.log('REFRESH RESULT:', r, '| new apiKey:', a.apiKey.slice(0, 20));
  return r;
};

try {
  const res = await client.forward({
    method: 'POST', path: '/chat/completions', query: '',
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({ model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    provider: 'qwen',
    allowAnonymous: true,
  });
  console.log('FORWARD STATUS:', res.status, '| body head:', (await res.text()).slice(0, 160));
} catch (e) {
  console.log('FORWARD THREW:', e?.message ?? e);
}
console.log('signinCalls:', signinCalls);
server.close();
