/**
 * Repro: run our qwenWeb.ts against the real upstream with the stored
 * qwen-1 account (same path as upstreamClient.fetchQwenWeb).
 * Prints only statuses / error messages — never credentials.
 */
import { readFileSync } from 'node:fs';
import { qwenChatCompletion, QwenWebError, validateQwenCredential } from '../src/qwenWeb.js';

const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const acct = cfg.accounts.find((a) => a.id === 'qwen-1');
if (!acct?.apiKey) {
  console.error('no qwen-1 account/apiKey found');
  process.exit(1);
}
console.log('account:', acct.id, '| credential length:', String(acct.apiKey).length, '| cookies:', !!acct.cookies);

const base = 'https://chat.qwen.ai';

// Step 1: cheap credential check (GET /api/v2/chats/).
try {
  const v = await validateQwenCredential(base, acct.apiKey, {}, acct.cookies);
  console.log('validate:', JSON.stringify(v));
} catch (e) {
  console.log('validate threw:', e instanceof Error ? e.message : e);
}

// Step 2: one real chat turn (non-stream so we get the full body).
try {
  const stream = await qwenChatCompletion({
    baseUrl: base,
    credential: acct.apiKey,
    cookies: acct.cookies,
    model: 'qwen3.7-plus',
    messages: [{ role: 'user', content: 'Say OK and nothing else.' }],
    stream: false,
  });
  const text = await new Response(stream).text();
  console.log('chat OK, body head:', text.slice(0, 400));
} catch (e) {
  if (e instanceof QwenWebError) {
    console.log('chat QwenWebError status=', e.status, 'message=', e.message.slice(0, 800));
  } else {
    console.log('chat threw:', e instanceof Error ? (e.stack ?? e.message) : e);
  }
}
