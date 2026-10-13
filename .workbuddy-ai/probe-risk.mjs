/** Which request shape trips risk control? Same token, three variants. */
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const acct = cfg.accounts.find((a) => a.id === 'qwen-1');
const token = String(acct.apiKey).trim();
const cookies = acct.cookies ? String(acct.cookies).trim() : '';
const model = 'qwen3.7-plus';
const base = 'https://chat.qwen.ai';

function headers(withCookie, accept) {
  const h = {
    Authorization: `Bearer ${token}`,
    'x-request-id': crypto.randomUUID(),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: accept ?? 'application/json, text/plain, */*',
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

function ourBody() {
  return {
    title: 'New Chat', models: [model], chat_mode: 'normal', chat_type: 't2t',
    timestamp: Date.now(), project_id: '',
  };
}

function refBody() {
  const secs = Math.floor(Date.now() / 1000);
  return { title: `api_${secs}`, models: [model], chat_mode: 'normal', chat_type: 't2t', timestamp: secs };
}

async function create(name, body, hdrs) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/api/v2/chats/new`, { method: 'POST', headers: hdrs, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const text = await r.text();
    let id = null;
    try { id = JSON.parse(text)?.data?.id ?? null; } catch { /* */ }
    console.log(`[${name}] ${r.status} ms=${Date.now() - t0} id=${id ? 'YES' : 'no'} body: ${text.slice(0, 220).replace(/\s+/g, ' ')}`);
    return id;
  } catch (e) {
    console.log(`[${name}] threw after ${Date.now() - t0}ms: ${e?.message ?? e}`);
    return null;
  }
}

const made = [];
made.push(await create('A bearer-only + our body', ourBody(), headers(false)));
if (!made[0]) made.push(await create('B bearer-only + ref body', refBody(), headers(false)));
if (!made[0] && !made[1]) made.push(await create('C bearer+cookies + ref body', refBody(), headers(true)));

for (const id of made.filter(Boolean)) {
  await fetch(`${base}/api/v2/chats/${id}`, { method: 'DELETE', headers: headers(false) })
    .then((r) => console.log(`cleanup ${id.slice(0, 8)}… → ${r.status}`))
    .catch(() => {});
}
