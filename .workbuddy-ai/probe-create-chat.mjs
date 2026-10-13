/**
 * Raw create-chat probe: compare our current request body with the
 * qwen2API reference body against the real upstream.
 * Prints statuses + response bodies only (no credentials).
 */
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const acct = cfg.accounts.find((a) => a.id === 'qwen-1');
const token = String(acct.apiKey).trim();
const cookies = acct.cookies ? String(acct.cookies).trim() : '';
const model = 'qwen3.7-plus';
const base = 'https://chat.qwen.ai';

function browserHeaders(withCookie) {
  const h = {
    Authorization: `Bearer ${token}`,
    'x-request-id': crypto.randomUUID(),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://chat.qwen.ai/',
    Origin: 'https://chat.qwen.ai',
    Connection: 'keep-alive',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  };
  if (withCookie && cookies) h.Cookie = cookies;
  return h;
}

async function probe(name, body, headers) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/api/v2/chats/new`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    let id = null;
    try { id = JSON.parse(text)?.data?.id ?? null; } catch { /* non-JSON */ }
    console.log(`[${name}] status=${r.status} ct=${r.headers.get('content-type')} ms=${Date.now() - t0} chatId=${id ? id.slice(0, 8) + '…' : 'none'}`);
    console.log(`[${name}] body: ${text.slice(0, 700).replace(/\s+/g, ' ')}`);
    return id;
  } catch (e) {
    console.log(`[${name}] threw after ${Date.now() - t0}ms: ${e?.message ?? e}`);
    return null;
  }
}

// A: our current qwenWeb.ts body + headers (Bearer + browser cookies)
const idA = await probe('A-ours', {
  title: 'New Chat',
  models: [model],
  chat_mode: 'normal',
  chat_type: 't2t',
  timestamp: Date.now(),
  project_id: '',
}, browserHeaders(true));

// B: reference qwen2API body + headers (Bearer only, seconds timestamp)
const secs = Math.floor(Date.now() / 1000);
const idB = await probe('B-reference', {
  title: `api_${secs}`,
  models: [model],
  chat_mode: 'normal',
  chat_type: 't2t',
  timestamp: secs,
}, browserHeaders(false));

// cleanup any chat we created
for (const id of [idA, idB]) {
  if (id) {
    await fetch(`${base}/api/v2/chats/${id}`, { method: 'DELETE', headers: browserHeaders(false) })
      .then((r) => console.log(`cleanup ${id.slice(0, 8)}… → ${r.status}`))
      .catch(() => {});
  }
}
