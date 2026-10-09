import { describe, it, expect } from 'vitest';
import { renderPrometheus } from '../prometheus.js';
import { Metrics } from '../metrics.js';
import { AccountPool } from '../accountPool.js';

describe('renderPrometheus', () => {
  it('renders counters, gauges and per-account series', () => {
    const m = new Metrics();
    m.requests = 10;
    m.successes = 8;
    m.rateLimited = 1;
    m.rotations = 2;
    m.retries = 3;
    m.failovers = 1;
    m.tokensSaved = 400;
    m.perAccount.set('a"b', 7);

    const pool = new AccountPool([{ id: 'k1', name: 'k1', provider: 'p', apiKey: 'x', priority: 1 }]);
    const text = renderPrometheus(m, pool);

    expect(text).toContain('opencode_max_requests_total 10');
    expect(text).toContain('opencode_max_successes_total 8');
    expect(text).toContain('opencode_max_rate_limited_total 1');
    expect(text).toContain('opencode_max_rotations_total 2');
    expect(text).toContain('opencode_max_retries_total 3');
    expect(text).toContain('opencode_max_failovers_total 1');
    expect(text).toContain('opencode_max_tokens_saved_total 400');
    expect(text).toContain('# TYPE opencode_max_requests_total counter');
    expect(text).toContain('# TYPE opencode_max_uptime_seconds gauge');
    // Label values are escaped.
    expect(text).toContain('opencode_max_account_requests_total{account="a\\"b"} 7');
    expect(text).toContain('opencode_max_account_inflight{account="k1"} 0');
  });

  it('works without a pool', () => {
    const m = new Metrics();
    const text = renderPrometheus(m);
    expect(text).toContain('opencode_max_requests_total 0');
    expect(text).not.toContain('opencode_max_account_inflight');
  });
});
