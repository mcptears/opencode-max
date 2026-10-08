import { describe, it, expect } from 'vitest';
import { QuotaTracker } from '../quota.js';
import { getDb } from '../db.js';

describe('QuotaTracker', () => {
  it('counts usage in the trailing window', () => {
    const q = new QuotaTracker();
    q.record('quota-a');
    q.record('quota-a');
    expect(q.usage('quota-a')).toBe(2);
    expect(q.usage('quota-other')).toBe(0);
  });

  it('detects over-quota and near-quota states', () => {
    const q = new QuotaTracker();
    for (let i = 0; i < 3; i++) q.record('quota-b'); // limit is 3 in tests
    expect(q.isOverQuota('quota-b')).toBe(true);
    q.record('quota-c');
    q.record('quota-c');
    expect(q.isOverQuota('quota-c')).toBe(false);
    expect(q.isNearQuota('quota-c')).toBe(false);
  });

  it('prunes events older than retention', () => {
    const q = new QuotaTracker();
    getDb()
      .prepare('INSERT INTO usage_events (account_id, ts) VALUES (?, ?)')
      .run('quota-old', Date.now() - 30 * 3600 * 1000);
    expect(q.usage('quota-old', 40 * 3600 * 1000)).toBe(1);
    q.prune();
    expect(q.usage('quota-old', 40 * 3600 * 1000)).toBe(0);
  });
});
