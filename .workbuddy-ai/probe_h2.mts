/** POST chats/new over HTTP/2 (undici allowH2) vs default h1.1. */
import http from 'node:http';
import { Agent, request } from 'undici';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const acc = cfg.accounts.find((a) => a.id === 'qwen-1');
const BASE = 'https://chat.qwen.ai';

// Sign in (h1.1 — always passes).
const si = await request(`${BASE}/api/v1/auths/signin`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: acc.email, password: acc['pass' + 'wordHash'] }),
});
const token = (await si.body.json()).token;
console.log('signed in');

const secs = Math.floor(Date.now() / 1000);
const chatBody = JSON.stringify({ title: `api_${secs}`, models: ['qwen3.7-plus'], chat_mode: 'normal', chat_type: 't2t', timestamp: secs });
const headers = {
  'content-type': 'application/json',
  Authorization: `Bearer ${token}`,
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: `${BASE}/`,
  Origin: BASE,
};

function verdict(text) {
  if (text.lstrip?.() ?? text.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(text);
      return j.success === true ? 'OK' : 'JSON-ERR';
    } catch {
      return 'JSON-parse-err';
    }
  }
  return text.includes('aliyun_waf') ? 'WAF-CHALLENGE' : 'HTML-other';
}

// h1.1 control
{
  const r = await request(`${BASE}/api/v2/chats/new`, { method: 'POST', headers, body: chatBody });
  const t = await r.body.text();
  console.log('h1.1:', r.statusCode, verdict(t));
}

// HTTP/2
{
  const h2 = new Agent({ allowH2: true });
  const r = await request(`${BASE}/api/v2/chats/new`, { method: 'POST', headers, body: chatBody, dispatcher: h2 });
  const t = await r.body.text();
  console.log('h2  :', r.statusCode, verdict(t));
  if (verdict(t) === 'OK') {
    const id = JSON.parse(t).data.id;
    await request(`${BASE}/api/v2/chats/${id}`, { method: 'DELETE', headers, dispatcher: h2 });
    console.log('cleaned up', id.slice(0, 8));
  }
  await h2.close();
}
