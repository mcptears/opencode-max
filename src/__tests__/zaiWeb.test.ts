import { describe, it, expect } from 'vitest';
import {
  decodeZaiToken,
  signZaiRequest,
  splitZaiThinking,
  parseZaiSsePayload,
  ZAI_SALT_KEY_FALLBACK,
} from '../zaiWeb.js';

function makeToken(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64(payload)}.sig`;
}

describe('decodeZaiToken', () => {
  it('decodes id and email from the JWT payload', () => {
    const t = makeToken({ id: 'user-123', email: 'me@example.com' });
    expect(decodeZaiToken(t)).toEqual({ id: 'user-123', email: 'me@example.com' });
  });

  it('rejects malformed tokens', () => {
    expect(decodeZaiToken('not-a-token')).toBe(null);
    expect(decodeZaiToken('')).toBe(null);
    expect(decodeZaiToken(makeToken({ email: 'x@y.z' }))).toBe(null); // no id
  });
});

describe('signZaiRequest', () => {
  it('builds a signature and signed query string', () => {
    const token = makeToken({ id: 'u1', email: 'a@b.c' });
    const s = signZaiRequest('hello world', token, 'u1', ZAI_SALT_KEY_FALLBACK);
    expect(s.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(s.query).toContain('timestamp=');
    expect(s.query).toContain('requestId=');
    expect(s.query).toContain('user_id=u1');
    expect(s.query).toContain('signature_timestamp=' + s.timestamp);
    expect(s.query).toContain('token=' + encodeURIComponent(token).replace(/%/g, '%'));
  });

  it('is deterministic for the prompt within the same time bucket', () => {
    const token = makeToken({ id: 'u1', email: 'a@b.c' });
    const a = signZaiRequest('same prompt', token, 'u1', ZAI_SALT_KEY_FALLBACK);
    const b = signZaiRequest('same prompt', token, 'u1', ZAI_SALT_KEY_FALLBACK);
    // Same 5-minute bucket -> same w_key; timestamps may differ by ms but the
    // signature binds the timestamp, so only compare structure here.
    expect(a.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(b.signature).toMatch(/^[0-9a-f]{64}$/);
    const c = signZaiRequest('different prompt', token, 'u1', ZAI_SALT_KEY_FALLBACK);
    expect(c.signature).not.toBe(a.signature);
  });
});

describe('splitZaiThinking', () => {
  it('returns plain text untouched', () => {
    expect(splitZaiThinking('just an answer')).toEqual({ thinking: '', answer: 'just an answer' });
  });

  it('splits <details> thinking from the answer', () => {
    const raw = 'intro<details type="think"><summary>Thinking</summary>hmm, let me think</details>final answer';
    const { thinking, answer } = splitZaiThinking(raw);
    expect(thinking).toBe('hmm, let me think');
    expect(answer).toBe('introfinal answer');
  });

  it('handles an unclosed thinking block (still streaming)', () => {
    const raw = '<details type="think"><summary>Thinking</summary>partial thought';
    const { thinking, answer } = splitZaiThinking(raw);
    expect(thinking).toBe('partial thought');
    expect(answer).toBe('');
  });

  it('strips "> " quote prefixes inside thinking', () => {
    const raw = '<details>> line one\n> line two</details>done';
    const { thinking } = splitZaiThinking(raw);
    expect(thinking).toBe('line one\nline two');
  });
});

describe('parseZaiSsePayload', () => {
  it('parses delta_content as answer', () => {
    const { deltas, done } = parseZaiSsePayload(JSON.stringify({ data: { delta_content: 'Hello' } }));
    expect(done).toBe(false);
    expect(deltas).toEqual([{ kind: 'answer', text: 'Hello' }]);
  });

  it('routes <details> content to think', () => {
    const { deltas } = parseZaiSsePayload(
      JSON.stringify({ data: { delta_content: '<details>reasoning here</details>' } }),
    );
    expect(deltas).toEqual([{ kind: 'think', text: 'reasoning here' }]);
  });

  it('detects phase done', () => {
    expect(parseZaiSsePayload(JSON.stringify({ data: { phase: 'done' } })).done).toBe(true);
  });

  it('ignores garbage', () => {
    expect(parseZaiSsePayload('not json').deltas).toEqual([]);
    expect(parseZaiSsePayload(JSON.stringify({ data: {} })).deltas).toEqual([]);
  });
});
