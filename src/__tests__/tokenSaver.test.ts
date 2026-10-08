import { describe, it, expect } from 'vitest';
import { compressToolResults, compressText } from '../tokenSaver.js';

describe('tokenSaver', () => {
  it('middle-truncates oversized tool results, keeping head and tail', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `unique-line-${i}-xxxxxxxx`);
    const body = { model: 'x', messages: [{ role: 'tool', content: lines.join('\n') }] };
    const saved = compressToolResults(body, 20000);
    expect(saved).toBeGreaterThan(0);
    const content = (body.messages[0] as { content: string }).content;
    expect(content.length).toBeLessThanOrEqual(20000);
    expect(content.startsWith('unique-line-0')).toBe(true);
    expect(content.trimEnd().endsWith('unique-line-2999-xxxxxxxx')).toBe(true);
    expect(content).toContain('to save tokens');
  });

  it('dedupes repeated log lines', () => {
    const body = { messages: [{ role: 'tool', content: 'err: boom\n'.repeat(5000) }] };
    const saved = compressToolResults(body, 20000);
    expect(saved).toBeGreaterThan(20000);
    expect((body.messages[0] as { content: string }).content).toContain('duplicate lines collapsed');
  });

  it('leaves small and non-tool content untouched', () => {
    const body = {
      messages: [
        { role: 'user', content: 'x'.repeat(50000) },
        { role: 'tool', content: 'ok' },
      ],
    };
    expect(compressToolResults(body, 20000)).toBe(0);
    expect(body.messages[0].content).toHaveLength(50000);
    expect(body.messages[1].content).toBe('ok');
  });

  it('handles Anthropic tool_result blocks', () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'z'.repeat(30000) }] }] };
    expect(compressToolResults(body, 20000)).toBeGreaterThan(0);
  });

  it('compressText is a no-op under the limit', () => {
    const r = compressText('short', 20000);
    expect(r.saved).toBe(0);
    expect(r.text).toBe('short');
  });
});
