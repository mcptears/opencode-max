import { describe, it, expect } from 'vitest';
import { AccountPool } from '../accountPool.js';
import { QuotaTracker } from '../quota.js';

const mk = (id: string, priority: number) => ({ id, name: id, provider: 'p', apiKey: 'k', priority });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AccountPool', () => {
  it('acquires the highest-priority account first', () => {
    const pool = new AccountPool([mk('pool-p2', 2), mk('pool-p1', 1)]);
    expect(pool.acquire()?.id).toBe('pool-p1');
  });

  it('parks an account on markLimited and reactivates after cooldown', async () => {
    const pool = new AccountPool([mk('pool-cd', 1)]);
    pool.markLimited('pool-cd', 40);
    expect(pool.acquire()).toBeNull();
    expect(pool.status()[0].state).toBe('cooling_down');
    await sleep(70);
    expect(pool.acquire()?.id).toBe('pool-cd');
  });

  it('skips invalid keys until reset', () => {
    const pool = new AccountPool([mk('pool-inv', 1)]);
    pool.markInvalid('pool-inv');
    expect(pool.acquire()).toBeNull();
    expect(pool.allInvalid()).toBe(true);
    expect(pool.status()[0].state).toBe('invalid');
    pool.clearInvalid('pool-inv');
    expect(pool.acquire()?.id).toBe('pool-inv');
    expect(pool.allInvalid()).toBe(false);
  });

  it('filters by provider', () => {
    const pool = new AccountPool([
      { ...mk('pool-pa', 1), provider: 'a' },
      { ...mk('pool-pb', 1), provider: 'b' },
    ]);
    expect(pool.acquire('b')?.id).toBe('pool-pb');
    expect(pool.acquire('zzz')).toBeNull();
  });

  it('prefers the least-used account on priority ties (quota steering)', () => {
    const q = new QuotaTracker();
    const pool = new AccountPool([mk('pool-q1', 1), mk('pool-q2', 1)], q);
    q.record('pool-q1');
    expect(pool.acquire()?.id).toBe('pool-q2');
  });

  it('excludes over-quota accounts until the window slides', () => {
    const q = new QuotaTracker();
    const pool = new AccountPool([mk('pool-qo1', 1), mk('pool-qo2', 1)], q);
    for (let i = 0; i < 3; i++) q.record('pool-qo1'); // limit is 3 in tests
    expect(q.isOverQuota('pool-qo1')).toBe(true);
    expect(pool.acquire()?.id).toBe('pool-qo2');
    for (let i = 0; i < 3; i++) q.record('pool-qo2');
    expect(pool.acquire()).toBeNull();
  });

  it('reports 5h usage in status', () => {
    const q = new QuotaTracker();
    const pool = new AccountPool([mk('pool-qs', 1)], q);
    q.record('pool-qs');
    q.record('pool-qs');
    expect(pool.status()[0].usage5h).toBe(2);
  });
});
