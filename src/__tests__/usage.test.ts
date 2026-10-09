import { describe, it, expect } from 'vitest';
import { extractUsageFromText, trackUsage } from '../usage.js';
import { Metrics } from '../metrics.js';

const sse = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

describe('extractUsageFromText', () => {
  it('reads usage from a plain JSON body', () => {
    const u = extractUsageFromText(
      JSON.stringify({ id: 'x', usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } }),
    );
    expect(u).toEqual({ prompt: 100, completion: 25, total: 125 });
  });

  it('reads usage from the final SSE chunk', () => {
    const body =
      'data: {"id":"1","choices":[]}\n\n' +
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n' +
      'data: [DONE]\n';
    expect(extractUsageFromText(body)).toEqual({ prompt: 10, completion: 4, total: 14 });
  });

  it('prefers the last usage chunk seen', () => {
    const body =
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
      'data: {"usage":{"prompt_tokens":50,"completion_tokens":20,"total_tokens":70}}\n\n';
    expect(extractUsageFromText(body)).toEqual({ prompt: 50, completion: 20, total: 70 });
  });

  it('derives total when total_tokens is missing', () => {
    const u = extractUsageFromText(JSON.stringify({ usage: { prompt_tokens: 30, completion_tokens: 12 } }));
    expect(u).toEqual({ prompt: 30, completion: 12, total: 42 });
  });

  it('returns undefined when no usage is present', () => {
    expect(extractUsageFromText('data: {"choices":[]}\n\ndata: [DONE]\n')).toBeUndefined();
    expect(extractUsageFromText('not json at all')).toBeUndefined();
    expect(extractUsageFromText('')).toBeUndefined();
  });
});

describe('trackUsage', () => {
  it('passes bytes through unchanged and reports usage', async () => {
    const payload = 'data: {"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\ndata: [DONE]\n';
    let seen: unknown;
    const wrapped = trackUsage(sse([payload.slice(0, 20), payload.slice(20)]), (u) => {
      seen = u;
    });
    expect(wrapped).not.toBeNull();
    const out = await drain(wrapped!);
    expect(out).toBe(payload);
    expect(seen).toEqual({ prompt: 7, completion: 3, total: 10 });
  });

  it('does not call back when there is no usage', async () => {
    let called = false;
    const wrapped = trackUsage(sse(['data: {"ok":true}\n\n']), () => {
      called = true;
    });
    await drain(wrapped!);
    expect(called).toBe(false);
  });

  it('returns null body as-is', () => {
    expect(trackUsage(null, () => {})).toBeNull();
  });
});

describe('metrics token usage', () => {
  it('aggregates per account and per model', () => {
    const m = new Metrics();
    m.logUsage('a1', 'm1', 100, 40);
    m.logUsage('a1', 'm1', 200, 60);
    m.logUsage('a2', 'm2', 10, 5);
    const s = m.usageStats(24);
    const a1 = s.byAccount.find((x) => x.accountId === 'a1');
    expect(a1).toMatchObject({ prompt: 300, completion: 100, total: 400, requests: 2 });
    const a2 = s.byAccount.find((x) => x.accountId === 'a2');
    expect(a2).toMatchObject({ prompt: 10, completion: 5, total: 15, requests: 1 });
    const m1 = s.byModel.find((x) => x.model === 'm1');
    expect(m1).toMatchObject({ prompt: 300, completion: 100, total: 400, requests: 2 });
  });
});
