/** Replicate the exact qwenWeb stack (warm-up + jar + Chrome TLS + pacing) for diagnosis. */
import { Agent, request } from 'undici';
import { readFileSync } from 'node:fs';
import { qwenSignIn } from '../src/qwenWeb.js';

const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const acc = cfg.accounts.find((a) => a.id === 'qwen-1');
const login = await qwenSignIn('https://chat.qwen.ai', acc.email, acc.passwordHash);
if (!login.ok) { console.log('relogin failed'); process.exit(1); }

const BASE = 'https://chat.qwen.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const agent = new Agent({
  connect: {
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
    ecdhCurve: 'X25519:P-256:P-384',
    ALPNProtocols: ['http/1.1'],
  },
});

// 1. warm-up GET + harvest cookies
const warm = await request(`${BASE}/`, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' }, dispatcher: agent });
const setC = warm.headers['set-cookie'] ?? [];
const cookies = (Array.isArray(setC) ? setC : [setC]).map((c) => String(c).split(';')[0]).join('; ');
await warm.body.dump();
console.log('warm-up:', warm.statusCode, '| cookies:', cookies.slice(0, 80));

// 2. create-chat with everything
await new Promise((r) => setTimeout(r, 300));
const secs = Math.floor(Date.now() / 1000);
const r = await request(`${BASE}/api/v2/chats/new`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    Authorization: `Bearer ${login.credential}`,
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Referer: `${BASE}/`,
    Origin: BASE,
    ...(cookies ? { cookie: cookies } : {}),
  },
  body: JSON.stringify({ title: `api_${secs}`, models: ['qwen3.7-plus'], chat_mode: 'normal', chat_type: 't2t', timestamp: secs }),
  dispatcher: agent,
});
const text = await r.body.text();
console.log('create-chat:', r.statusCode, '| ct:', r.headers['content-type']);
console.log('body:', text.slice(0, 420).replace(/\s+/g, ' '));
await agent.close();
