import { describe, it, expect, beforeEach } from 'vitest';
import { Metrics } from '../metrics.js';
import { getDb } from '../db.js';

const providerOf = (id: string) => (id === 'a1' || id === 'a2' ? 'p1' : id === 'b1' ? 'p2' : '');

beforeEach(() => {
  getDb().prepare('DELETE FROM request_log').run();
});

describe('providerHealth', () => {
  it('aggregates requests, success rate, latency and last error per provider', () => {
    const m = new Metrics();
    m.logRequest('a1', 200, 100, 'm1');
    m.logRequest('a2', 200, 200, 'm1');
    m.logRequest('a1', 500, 300, 'm1');
    m.logRequest('b1', 429, 50, 'm2');

    const h = m.providerHealth(24, providerOf);
    const p1 = h.find((x) => x.provider === 'p1')!;
    expect(p1.requests).toBe(3);
    expect(p1.errors).toBe(1);
    expect(p1.successRate).toBeCloseTo(66.7, 1);
    expect(p1.avgLatencyMs).toBe(200);
    expect(p1.lastErrorStatus).toBe(500);
    expect(typeof p1.lastErrorAt).toBe('number');

    const p2 = h.find((x) => x.provider === 'p2')!;
    expect(p2.requests).toBe(1);
    expect(p2.errors).toBe(1);
    expect(p2.successRate).toBe(0);
    expect(p2.lastErrorStatus).toBe(429);
  });

  it('reports 100% success and no last error for a clean provider', () => {
    const m = new Metrics();
    m.logRequest('a1', 200, 80, 'm1');
    const [p1] = m.providerHealth(24, providerOf);
    expect(p1.successRate).toBe(100);
    expect(p1.lastErrorStatus).toBeNull();
    expect(p1.lastErrorAt).toBeNull();
  });

  it('returns [] when there is no data', () => {
    const m = new Metrics();
    expect(m.providerHealth(24, providerOf)).toEqual([]);
  });
});
