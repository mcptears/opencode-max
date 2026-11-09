import { describe, it, expect } from 'vitest';
import {
  CONSOLE_BASE,
  GO_BASE,
  isFreeModel,
  isGateway,
  normalizeBase,
  normalizePlan,
  parseRetryAfter,
  parseZenUsage,
  parseZenUsageFromText,
  pickPaidModel,
  planFromBase,
  zenEndpoint,
} from '../zen.js';

describe('zen gateway helpers', () => {
  it('migrates legacy zen bases', () => {
    expect(normalizeBase('https://opencode.ai/zen/v1/')).toBe(CONSOLE_BASE);
    expect(normalizeBase('https://opencode.ai/zen/go/v1')).toBe(GO_BASE);
    expect(normalizeBase('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(isGateway(CONSOLE_BASE)).toBe(true);
    expect(isGateway(GO_BASE)).toBe(true);
    expect(isGateway('https://api.openai.com/v1')).toBe(false);
  });

  it('normalizes plans and picks the matching root', () => {
    expect(normalizePlan('Go')).toBe('go');
    expect(normalizePlan('pay-as-you-go')).toBe('console');
    expect(normalizePlan('nonsense')).toBeNull();
    expect(planFromBase('https://opencode.ai/zen/go/v1')).toBe('go');
    expect(planFromBase(CONSOLE_BASE)).toBe('console');
  });

  it('inserts the API-family prefix for zen endpoints', () => {
    expect(zenEndpoint(CONSOLE_BASE, '/chat/completions')).toBe(`${CONSOLE_BASE}/openai/v1/chat/completions`);
    expect(zenEndpoint(CONSOLE_BASE, '/responses')).toBe(`${CONSOLE_BASE}/openai/v1/responses`);
    expect(zenEndpoint(CONSOLE_BASE, '/messages')).toBe(`${CONSOLE_BASE}/anthropic/v1/messages`);
    expect(zenEndpoint(CONSOLE_BASE, '/models')).toBe(`${CONSOLE_BASE}/v1/models`);
    expect(zenEndpoint(GO_BASE, '/chat/completions')).toBe(`${GO_BASE}/openai/v1/chat/completions`);
    expect(zenEndpoint('https://api.openai.com/v1', '/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('detects free models and picks a paid one', () => {
    expect(isFreeModel('kimi-k3-free')).toBe(true);
    expect(isFreeModel('big-pickle')).toBe(true);
    expect(isFreeModel('kimi-k3')).toBe(false);
    expect(pickPaidModel(['x-free', 'big-pickle', 'kimi-k3'])).toBe('kimi-k3');
    expect(pickPaidModel(['x-free', 'big-pickle'])).toBeNull();
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('12')).toBe(12_000);
    expect(parseRetryAfter('')).toBe(0);
    expect(parseRetryAfter('nonsense')).toBe(0);
    const now = Date.UTC(2026, 0, 1);
    const date = new Date(now + 90_000).toUTCString();
    expect(parseRetryAfter(date, now)).toBe(90_000);
  });

  it('extracts Zen cost/allowance metadata', () => {
    const body = {
      usage: {
        cost: 0.2,
        opencode: { billing_source: 'go', list_cost: 0.2, allowance: 0.15, tokens: { input: 10, output: 5 } },
      },
    };
    expect(parseZenUsage(body)).toMatchObject({
      billingSource: 'go',
      cost: 0.2,
      allowance: 0.15,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(parseZenUsage({ usage: { prompt_tokens: 1 } })).toBeNull();
    const sse = `data: ${JSON.stringify(body)}\n\ndata: [DONE]\n`;
    expect(parseZenUsageFromText(sse)?.allowance).toBe(0.15);
  });
});
