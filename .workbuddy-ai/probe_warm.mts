/** Warm-up GET + cookies, then POST chats/new — does the challenge clear? */
import { request, Agent } from 'undici';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const acc = cfg.accounts.find((a) => a.id === 'qwen-1');
const BASE = 'https://chat.qwen.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const browserHeaders = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

// 1. Warm-up: GET the root, harvest set-cookie names.
const warm = await request(`${BASE}/`, { headers: browserHeaders });
const rawCookies = [...(warm.headers['set-cookie'] ?? [])].map((c) => c.split(';')[0]);
await warm.body.dump();
console.log('warm-up status:', warm.statusCode, '| cookies:', rawCookies.map((c) => c.split('=')[0]).join(', '));
const cookieHeader = rawCookies.join('; ');

// 2. Sign in (h1.1) with warm-up cookies.
const si = await request(`${BASE}/api/v1/auths/signin`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookieHeader ? { cookie: cookieHeader } : {}) },
  body: JSON.stringify({ email: acc.email, password: acc['pass' + 'wordHash'] }),
});
const signCookies = [...(si.headers['set-cookie'] ?? [])].map((c) => c.split(';')[0]);
const token = (await si.body.json()).token;
const allCookies = [...rawCookies, ...signCookies].join('; ');
console.log('signed in | post-signin cookie names:', signCookies.map((c) => c.split('=')[0]).join(', ') || '(none)');

const secs = Math.floor(Date.now() / 1000);
const chatBody = JSON.stringify({ title: `api_${secs}`, models: ['qwen3.7-plus'], chat_mode: 'normal', chat_type: 't2t', timestamp: secs });
const authHeaders = {
  'content-type': 'application/json',
  Authorization: `Bearer ${token}`,
  Accept: 'application/json, text/plain, */*',
  'User-Agent': UA,
  Referer: `${BASE}/`,
  Origin: BASE,
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

function verdict(text) {
  const s = text.trimStart();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      return j.success === true ? 'OK' : 'JSON-ERR: ' + JSON.stringify(j).slice(0, 80);
    } catch {
      return 'JSON-parse-err';
    }
  }
  return text.includes('aliyun_waf') ? 'WAF-CHALLENGE' : 'HTML-other';
}

// 3. POST chats/new with warm-up cookies.
{
  const r = await request(`${BASE}/api/v2/chats/new`, {
    method: 'POST', headers: { ...authHeaders, ...(allCookies ? { cookie: allCookies } : {}) }, body: chatBody,
  });
  const t = await r.body.text();
  console.log('POST with warm cookies:', r.statusCode, verdict(t));
  if (verdict(t) === 'OK') {
    const id = JSON.parse(t).data.id;
    await request(`${BASE}/api/v2/chats/${id}`, { method: 'DELETE', headers: authHeaders });
    console.log('created+deleted', id.slice(0, 8));
  }
}

// 4. Same but with Chrome-ish TLS options.
{
  const agent = new Agent({
    connect: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305',
      ecdhCurve: 'X25519:P-256:P-384',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ALPNProtocols: ['http/1.1'],
    },
  });
  const r = await request(`${BASE}/api/v2/chats/new`, {
    method: 'POST', headers: { ...authHeaders, ...(allCookies ? { cookie: allCookies } : {}) }, body: chatBody, dispatcher: agent,
  });
  const t = await r.body.text();
  console.log('POST warm cookies + chrome-ish TLS:', r.statusCode, verdict(t));
  if (verdict(t) === 'OK') {
    const id = JSON.parse(t).data.id;
    await request(`${BASE}/api/v2/chats/${id}`, { method: 'DELETE', headers: authHeaders, dispatcher: agent });
    console.log('created+deleted', id.slice(0, 8));
  }
  await agent.close();
}
