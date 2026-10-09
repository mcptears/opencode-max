import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  flattenMessages,
  parseQwenDelta,
  qwenAuthHeaders,
  resolveQwenModel,
  qwenChatCompletion,
  validateQwenCredential,
  QwenWebError,
} from '../qwenWeb.js';

/** Minimal mock of chat.qwen.ai's v2 web API. */
let server: http.Server | null = null;
let base = '';
let lastCreateBody: unknown = null;
let lastCompletionBody: unknown = null;
let mode: 'ok' | 'risk' | 'unauth' | 'empty' = 'ok';

const sseBody = [
  'data: {"choices":[{"delta":{"phase":"think","content":"let me think"}}]}',
  'data: {"choices":[{"delta":{"phase":"thinking_summary","content":"summary"}}]}',
  'data: {"choices":[{"delta":{"phase":"answer","content":"Hello "}}]}',
  'data: {"choices":[{"delta":{"phase":"answer","content":"world"}}]}',
  'data: {"choices":[{"delta":{"content":"!"}}]}',
  'data: [DONE]',
].join('\n\n');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.startsWith('/api/v2/chats/?') && req.method === 'GET') {
        if (mode === 'unauth') {
          res.writeHead(401).end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true,"data":[]}');
        return;
      }
      if (url === '/api/v2/chats/new' && req.method === 'POST') {
        lastCreateBody = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true,"data":{"id":"chat-123"}}');
        return;
      }
      if (url.startsWith('/api/v2/chat/completions') && req.method === 'POST') {
        lastCompletionBody = JSON.parse(body);
        // Auth must ride on Cookie or Bearer with source: web.
        if (req.headers['source'] !== 'web') {
          res.writeHead(400).end('{}');
          return;
        }
        if (mode === 'risk') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"code":"FAIL_SYS_USER_VALIDATE"}');
          return;
        }
        if (mode === 'unauth') {
          res.writeHead(401).end('{}');
          return;
        }
        if (mode === 'empty') {
          res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody);
        return;
      }
      if (url.startsWith('/api/v2/chats/chat-123') && req.method === 'DELETE') {
        res.writeHead(200).end('{}');
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mode = 'ok';
});

afterAll(async () => {
  await new Promise((r) => server!.close(r));
});

async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe('qwenWeb protocol', () => {
  it('sends cookie credentials as Cookie, tokens as Bearer', () => {
    expect(qwenAuthHeaders('abc=123; def=456')).toEqual({ cookie: 'abc=123; def=456' });
    expect(qwenAuthHeaders('Cookie: abc=123')).toEqual({ cookie: 'abc=123' });
    expect(qwenAuthHeaders('plain-token')).toEqual({ authorization: 'Bearer plain-token' });
  });

  it('resolves models via map, case-insensitive, with default fallback', () => {
    const map = { 'qwen-max': 'qwen3.7-max' };
    expect(resolveQwenModel(map, 'qwen3.7-plus', 'QWEN-MAX')).toBe('qwen3.7-max');
    expect(resolveQwenModel(map, 'qwen3.7-plus', 'unknown')).toBe('qwen3.7-plus');
    expect(resolveQwenModel(undefined, 'qwen3.7-plus', 'qwen-max')).toBe('qwen3.7-plus');
  });

  it('flattens messages into a single prompt', () => {
    const out = flattenMessages([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ]);
    expect(out).toContain('be nice');
    expect(out).toContain('[User]: hi');
    expect(out).toContain('[Assistant]: hello');
    expect(out).toContain('again');
  });

  it('parses think/answer phases', () => {
    expect(parseQwenDelta('{"choices":[{"delta":{"phase":"think","content":"x"}}]}')).toEqual({ kind: 'think', text: 'x' });
    expect(parseQwenDelta('{"choices":[{"delta":{"phase":"answer","content":"y"}}]}')).toEqual({ kind: 'answer', text: 'y' });
    expect(parseQwenDelta('{"choices":[{"delta":{"content":"z"}}]}')).toEqual({ kind: 'answer', text: 'z' });
    expect(parseQwenDelta('not json')).toBeNull();
  });

  it('validates a good credential', async () => {
    expect(await validateQwenCredential(base, 'tok')).toEqual({ ok: true });
  });

  it('rejects a bad credential', async () => {
    mode = 'unauth';
    const r = await validateQwenCredential(base, 'bad');
    expect(r.ok).toBe(false);
    mode = 'ok';
  });

  it('streams translated OpenAI SSE with reasoning_content', async () => {
    const stream = await qwenChatCompletion({
      baseUrl: base,
      credential: 'tok',
      model: 'qwen3.7-plus',
      responseModel: 'qwen-max',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    const text = await readAll(stream);
    expect(text).toContain('reasoning_content');
    expect(text).toContain('let me think');
    expect(text).toContain('"content":"Hello "');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('"model":"qwen-max"');
    // Chat lifecycle: created with the qwen model, message sent with fid.
    expect((lastCreateBody as { models: string[] }).models).toEqual(['qwen3.7-plus']);
    const msg = (lastCompletionBody as { messages: { fid: string; content: string }[] }).messages[0];
    expect(msg.fid).toBeTruthy();
    expect(msg.content).toContain('hello');
  });

  it('collects a JSON completion when stream=false', async () => {
    const stream = await qwenChatCompletion({
      baseUrl: base,
      credential: 'tok',
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
    const j = JSON.parse(await readAll(stream));
    expect(j.object).toBe('chat.completion');
    expect(j.choices[0].message.content).toBe('Hello world!');
    expect(j.choices[0].message.reasoning_content).toContain('let me think');
    expect(j.choices[0].finish_reason).toBe('stop');
  });

  it('maps risk-control JSON to a 429', async () => {
    mode = 'risk';
    try {
      await qwenChatCompletion({ baseUrl: base, credential: 'tok', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QwenWebError);
      expect((e as QwenWebError).status).toBe(429);
    }
    mode = 'ok';
  });

  it('maps 401 to an invalid-credential error', async () => {
    mode = 'unauth';
    try {
      await qwenChatCompletion({ baseUrl: base, credential: 'bad', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });
      expect.unreachable();
    } catch (e) {
      expect((e as QwenWebError).status).toBe(401);
    }
    mode = 'ok';
  });

  it('rejects empty completions', async () => {
    mode = 'empty';
    try {
      await qwenChatCompletion({ baseUrl: base, credential: 'tok', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: false });
      expect.unreachable();
    } catch (e) {
      expect((e as QwenWebError).status).toBe(502);
    }
    mode = 'ok';
  });
});
