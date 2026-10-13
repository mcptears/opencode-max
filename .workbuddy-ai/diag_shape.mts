/** One diagnostic: raw create-chat + completions response shapes. */
import { readFileSync } from 'node:fs';
import { qwenSignIn } from '../src/qwenWeb.js';

const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const acc = cfg.accounts.find((a) => a.id === 'qwen-1');
const login = await qwenSignIn('https://chat.qwen.ai', acc.email, acc.passwordHash);
if (!login.ok) {
  console.log('relogin failed', login.error);
  process.exit(1);
}
const token = login.credential;
const BASE = 'https://chat.qwen.ai';
const H = {
  'content-type': 'application/json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: `${BASE}/`,
  Origin: BASE,
};

const secs = Math.floor(Date.now() / 1000);
const r = await fetch(`${BASE}/api/v2/chats/new`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `api_${secs}`, models: ['qwen3.7-plus'], chat_mode: 'normal', chat_type: 't2t', timestamp: secs }),
  signal: AbortSignal.timeout(45000),
});
const text = await r.text();
console.log('create-chat:', r.status, '| ct:', r.headers.get('content-type'));
console.log('body:', text.slice(0, 400).replace(/\s+/g, ' '));
