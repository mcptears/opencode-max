import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  deepseekChatCompletion,
  deepseekSignIn,
  validateDeepSeekCredential,
  deepseekHashV1,
  type PowChallenge,
} from '../deepseekWeb.js';

/**
 * End-to-end against a mock chat.deepseek.com: verifies the request sequence
 * (session create -> PoW challenge -> completion with x-ds-pow-response ->
 * session delete), the SSE translation, and the login flow.
 */
describe('deepseek web flow (mock upstream)', () => {
  let base = '';
  let server: http.Server | null = null;
  const seen: { method: string; path: string; headers: Record<string, string | undefined>; body: string }[] = [];
  let completionPowHeader = '';

  // A challenge the real solver can crack quickly: the digest of nonce 42.
  const salt = 'abcdef1234567890abcd';
  const expireAt = 1787756464033;
  const enc = new TextEncoder();
  const answer = 42;
  const challengeHex = [...deepseekHashV1(enc.encode(`${salt}_${expireAt}_${answer}`))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const challenge: PowChallenge = {
    algorithm: 'DeepSeekHashV1',
    challenge: challengeHex,
    salt,
    difficulty: 5000,
    expire_at: expireAt,
    signature: 'sig',
    target_path: '/api/v0/chat/completion',
  };

  const sseBody = [
    'event: ready',
    'data: {"request_message_id":1,"response_message_id":2}',
    '',
    'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"Let me think"}]}}}',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" more"}',
    '',
    'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"Hello"}]}',
    '',
    'data: {"v":" world"}',
    '',
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":42}]}',
    '',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    '',
  ].join('\n');

  beforeAll(async () => {
    expect(answer).toBeGreaterThanOrEqual(0);
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v;
        seen.push({ method: req.method ?? '', path: req.url ?? '', headers, body });
        const json = (o: unknown) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(o));
        };
        if (req.url === '/api/v0/users/login') {
          const b = JSON.parse(body);
          expect(b.os).toBe('web');
          expect(b.email).toBe('u@example.com');
          expect(typeof b.device_id).toBe('string');
          json({ code: 0, data: { biz_code: 0, biz_data: { user: { token: 'tok-abc' } } } });
        } else if (req.url === '/api/v0/chat_session/create') {
          json({ code: 0, data: { biz_code: 0, biz_data: { chat_session: { id: 'sess-1' } } } });
        } else if (req.url === '/api/v0/chat/create_pow_challenge') {
          json({ code: 0, data: { biz_code: 0, biz_data: { challenge } } });
        } else if (req.url === '/api/v0/chat/completion') {
          completionPowHeader = headers['x-ds-pow-response'] ?? '';
          res.setHeader('content-type', 'text/event-stream');
          res.end(sseBody);
        } else if (req.url === '/api/v0/chat_session/delete') {
          json({ code: 0, data: { biz_code: 0, biz_data: {} } });
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server!.close(r));
  });

  it('signs in and extracts the token', async () => {
    const r = await deepseekSignIn(base, 'u@example.com', 'a'.repeat(64));
    expect(r).toEqual({ ok: true, credential: 'tok-abc' });
  });

  it('validates a credential via session create+delete', async () => {
    expect(await validateDeepSeekCredential(base, 'tok-abc')).toEqual({ ok: true });
  });

  it('runs a full chat turn with PoW and translates SSE (non-streaming)', async () => {
    seen.length = 0;
    const stream = await deepseekChatCompletion({
      baseUrl: base,
      credential: 'tok-abc',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
      responseModel: 'deepseek-chat',
    });
    const text = await new Response(stream).text();
    const j = JSON.parse(text);
    expect(j.object).toBe('chat.completion');
    expect(j.choices[0].message.content).toBe('Hello world');
    expect(j.choices[0].message.reasoning_content).toBe('Let me think more');
    expect(j.usage.completion_tokens).toBe(42);

    // PoW header was sent and carries the solved answer.
    expect(completionPowHeader).toBeTruthy();
    const pow = JSON.parse(Buffer.from(completionPowHeader, 'base64').toString('utf8'));
    expect(pow.answer).toBe(answer);
    expect(pow.algorithm).toBe('DeepSeekHashV1');

    // Completion body shape.
    const comp = seen.find((s) => s.path === '/api/v0/chat/completion')!;
    const cb = JSON.parse(comp.body);
    expect(cb.chat_session_id).toBe('sess-1');
    expect(cb.model_type).toBe('default');
    expect(cb.thinking_enabled).toBe(false);
    expect(cb.prompt).toContain('Hi');
    expect(comp.headers['x-client-bundle-id']).toBe('com.deepseek.chat');

    // Session lifecycle: create ... delete (delete is best-effort/fire-and-forget).
    const paths = seen.map((s) => s.path);
    expect(paths[0]).toBe('/api/v0/chat_session/create');
    expect(paths).toContain('/api/v0/chat/create_pow_challenge');
    for (let i = 0; i < 50 && !seen.some((s) => s.path === '/api/v0/chat_session/delete'); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen.some((s) => s.path === '/api/v0/chat_session/delete')).toBe(true);
  });

  it('streams OpenAI chunks for stream=true', async () => {
    const stream = await deepseekChatCompletion({
      baseUrl: base,
      credential: 'tok-abc',
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    const text = await new Response(stream).text();
    expect(text).toContain('"reasoning_content":"Let me think"');
    expect(text).toContain('"reasoning_content":" more"');
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"content":" world"');
    expect(text).toContain('data: [DONE]');
    // reasoner -> thinking model_type
    const comp = seen.filter((s) => s.path === '/api/v0/chat/completion').pop()!;
    expect(JSON.parse(comp.body).model_type).toBe('thinking');
  });
});
