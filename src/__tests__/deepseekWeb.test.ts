import { describe, it, expect } from 'vitest';
import {
  deepseekHashV1,
  solveDeepSeekPoW,
  powResponseHeader,
  parseDeepSeekDelta,
  resolveDeepSeekModel,
  resolveDeepSeekModelName,
  generateDeviceId,
  flattenDeepSeekMessages,
  DEEPSEEK_MODELS,
  type PowChallenge,
} from '../deepseekWeb.js';

/** Live-captured challenge (verified: the browser solver found nonce 75656). */
const CAPTURED: PowChallenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: 'ea74b2a42974e90c46295a2fbd0b6942bb686efc1b71e5aa70abeda64869ade4',
  salt: '09fd35c1f240633d7545',
  difficulty: 144000,
  expire_at: 1787756464033,
  signature: '5ce10c31b8ca477528013c3695ee1ec04f83f79185e8161b37c9770545352a23',
  target_path: '/api/v0/chat/completion',
};

describe('DeepSeekHashV1', () => {
  it('solves the live-captured challenge', async () => {
    const nonce = await solveDeepSeekPoW(CAPTURED);
    expect(nonce).toBe(75656);
  }, 30000);

  it('is deterministic and 32 bytes', () => {
    const a = deepseekHashV1(new TextEncoder().encode('hello'));
    const b = deepseekHashV1(new TextEncoder().encode('hello'));
    expect(a.length).toBe(32);
    expect([...a].join(',')).toBe([...b].join(','));
  });

  it('differs from standard SHA3-256 (rounds 1..23, not 0..23)', async () => {
    const { createHash } = await import('node:crypto');
    const std = createHash('sha3-256').update('hello').digest('hex');
    const ds = [...deepseekHashV1(new TextEncoder().encode('hello'))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
    expect(ds).not.toBe(std);
  });

  it('rejects unknown algorithms', async () => {
    await expect(solveDeepSeekPoW({ ...CAPTURED, algorithm: 'nope' })).rejects.toThrow(/unsupported/);
  });

  it('rejects invalid difficulty', async () => {
    await expect(solveDeepSeekPoW({ ...CAPTURED, difficulty: 0 })).rejects.toThrow(/difficulty/);
  });
});

describe('powResponseHeader', () => {
  it('encodes the six-field envelope as base64 JSON', () => {
    const h = powResponseHeader(CAPTURED, 75656);
    const j = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    expect(j).toEqual({
      algorithm: 'DeepSeekHashV1',
      challenge: CAPTURED.challenge,
      salt: CAPTURED.salt,
      answer: 75656,
      signature: CAPTURED.signature,
      target_path: '/api/v0/chat/completion',
    });
  });
});

describe('parseDeepSeekDelta', () => {
  it('parses the initial envelope with THINK + RESPONSE fragments', () => {
    const state = { fragmentType: '' };
    const ds = parseDeepSeekDelta(
      JSON.stringify({ v: { response: { fragments: [{ type: 'THINK', content: 'We' }, { type: 'RESPONSE', content: 'Hi' }] } } }),
      state,
    );
    expect(ds).toEqual([
      { kind: 'think', text: 'We' },
      { kind: 'answer', text: 'Hi' },
    ]);
    expect(state.fragmentType).toBe('RESPONSE');
  });

  it('routes APPEND patches by current fragment type', () => {
    const state = { fragmentType: 'THINK' };
    const think = parseDeepSeekDelta(JSON.stringify({ p: 'response/fragments/-1/content', o: 'APPEND', v: ' need' }), state);
    expect(think).toEqual([{ kind: 'think', text: ' need' }]);
    // new RESPONSE fragment array flips the destination
    parseDeepSeekDelta(JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'P' }] }), state);
    const ans = parseDeepSeekDelta(JSON.stringify({ p: 'response/fragments/-1/content', v: 'ONG' }), state);
    expect(ans).toEqual([{ kind: 'answer', text: 'ONG' }]);
  });

  it('treats bare {"v":"..."} as a continuation of the last path', () => {
    const state = { fragmentType: 'RESPONSE' };
    expect(parseDeepSeekDelta(JSON.stringify({ v: ' answer' }), state)).toEqual([{ kind: 'answer', text: ' answer' }]);
    state.fragmentType = 'THINK';
    expect(parseDeepSeekDelta(JSON.stringify({ v: ' hmm' }), state)).toEqual([{ kind: 'think', text: ' hmm' }]);
  });

  it('detects FINISHED and usage', () => {
    const state = { fragmentType: '' };
    expect(parseDeepSeekDelta(JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' }), state)).toEqual([
      { kind: null, text: '', done: true },
    ]);
    const u = parseDeepSeekDelta(
      JSON.stringify({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 65 }] }),
      state,
    );
    expect(u).toEqual([{ kind: null, text: '', usage: 65 }]);
  });

  it('ignores control frames and garbage', () => {
    const state = { fragmentType: '' };
    expect(parseDeepSeekDelta(JSON.stringify({ request_message_id: 1 }), state)).toEqual([]);
    expect(parseDeepSeekDelta('not json', state)).toEqual([]);
  });
});

describe('resolveDeepSeekModel', () => {
  it('maps reasoner names to thinking', () => {
    const r = resolveDeepSeekModel(undefined, 'deepseek-chat', 'deepseek-reasoner');
    expect(r).toMatchObject({ modelType: 'thinking', thinkingEnabled: true, searchEnabled: false });
  });

  it('maps expert names', () => {
    const r = resolveDeepSeekModel(undefined, 'deepseek-chat', 'deepseek-expert');
    expect(r).toMatchObject({ modelType: 'expert', thinkingEnabled: false });
  });

  it('defaults to the default model', () => {
    const r = resolveDeepSeekModel(undefined, 'deepseek-chat', undefined);
    expect(r).toMatchObject({ modelType: 'default', thinkingEnabled: false, searchEnabled: false });
  });

  it('applies provider toggles as defaults', () => {
    const r = resolveDeepSeekModel(undefined, 'deepseek-chat', 'deepseek-chat', { thinkingEnabled: true, searchEnabled: true });
    expect(r).toMatchObject({ modelType: 'thinking', thinkingEnabled: true, searchEnabled: true });
  });

  it('lets explicit model markers win over toggles', () => {
    // reasoner forces thinking even when the toggle is off
    const r = resolveDeepSeekModel(undefined, 'deepseek-chat', 'deepseek-reasoner', { thinkingEnabled: false });
    expect(r.thinkingEnabled).toBe(true);
    // ...and a plain name with toggles off stays off
    const r2 = resolveDeepSeekModel(undefined, 'deepseek-chat', 'deepseek-chat', { thinkingEnabled: false, searchEnabled: false });
    expect(r2).toMatchObject({ thinkingEnabled: false, searchEnabled: false });
  });

  it('honours the modelMap', () => {
    expect(resolveDeepSeekModelName({ 'ds-r1': 'deepseek-reasoner' }, 'deepseek-chat', 'ds-r1')).toBe('deepseek-reasoner');
    expect(resolveDeepSeekModelName({ 'ds-r1': 'deepseek-reasoner' }, 'deepseek-chat', 'DS-R1')).toBe('deepseek-reasoner');
    expect(resolveDeepSeekModelName(undefined, 'deepseek-chat', 'unknown-model')).toBe('deepseek-chat');
  });
});

describe('helpers', () => {
  it('generates a browser-style device id', () => {
    const id = generateDeviceId();
    expect(id.length).toBe(88);
    expect(id.startsWith('B')).toBe(true);
    expect(id.endsWith('==')).toBe(true);
    expect(generateDeviceId()).not.toBe(id);
  });

  it('flattens messages', () => {
    expect(
      flattenDeepSeekMessages([
        { role: 'system', content: 'Be nice.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ]),
    ).toBe('Be nice.\n\n[User]: Hi\n\n[Assistant]: Hello');
  });

  it('exposes the model list', () => {
    expect(DEEPSEEK_MODELS).toContain('deepseek-chat');
    expect(DEEPSEEK_MODELS).toContain('deepseek-reasoner');
  });
});
