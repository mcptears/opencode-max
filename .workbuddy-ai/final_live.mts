/** Final live check: relogin (stored hash) -> full qwenWeb stack (warm pool + pacing + warm-up). */
import { readFileSync, writeFileSync } from 'node:fs';
import { qwenSignIn, qwenChatCompletion, QwenWebError, validateQwenCredential } from '../src/qwenWeb.js';

const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const acc = cfg.accounts.find((a) => a.id === 'qwen-1');
const base = 'https://chat.qwen.ai';
console.log('account:', acc.id, '| has email:', !!acc.email, '| has passwordHash:', !!acc.passwordHash, '| stored apiKey len:', String(acc.apiKey ?? '').length);

// 1. Sign in with the stored hash (same call the server's auto-relogin makes).
const login = await qwenSignIn(base, acc.email, acc.passwordHash);
if (!login.ok) {
  console.log('relogin FAILED:', login.error);
  process.exit(1);
}
console.log('relogin OK — new credential len:', login.credential.length);

// 2. Validate through the fixed validate path.
console.log('validate:', JSON.stringify(await validateQwenCredential(base, login.credential)));

// 3. Persist the fresh credential (what upstreamClient.doRefreshQwenCredential does).
acc.apiKey = login.credential;
writeFileSync(new URL('../accounts.json', import.meta.url), JSON.stringify(cfg, null, 2) + '\n');

// 4. One real chat turn through our full stack (warm pool creates the chat here).
try {
  const stream = await qwenChatCompletion({
    baseUrl: base,
    credential: acc.apiKey,
    model: 'qwen3.7-plus',
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    stream: false,
  });
  const j = JSON.parse(await new Response(stream).text());
  console.log('chat turn OK | model:', j.model, '| answer:', JSON.stringify(j.choices?.[0]?.message?.content ?? '').slice(0, 60));
} catch (e) {
  if (e instanceof QwenWebError) {
    console.log('chat QwenWebError status=', e.status, '|', e.message.slice(0, 140));
  } else {
    console.log('chat threw:', e?.message ?? e);
  }
}
