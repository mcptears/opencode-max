/** Control probes: does GET /api/v2/chats/ actually validate the token? */
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const acct = cfg.accounts.find((a) => a.id === 'qwen-1');
const token = String(acct.apiKey).trim();
console.log('token shape: len=', token.length, 'starts with', JSON.stringify(token.slice(0, 6)), 'contains "=":', token.includes('='), 'contains "token=":', token.startsWith('token='));

async function probe(name, authHeader) {
  const r = await fetch('https://chat.qwen.ai/api/v2/chats/?page=1&exclude_project=true', {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      'x-request-id': crypto.randomUUID(),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://chat.qwen.ai/',
      Origin: 'https://chat.qwen.ai',
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  console.log(`[${name}] status=${r.status} body: ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
}

await probe('stored-token', `Bearer ${token}`);
await probe('garbage-token', 'Bearer garbage.invalid.token');
