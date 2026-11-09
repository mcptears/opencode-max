import { getDb } from './db.js';
import { getSettings } from './settings.js';
import type { ZenUsage } from './zen.js';

export const WINDOW_5H_MS = 5 * 3600 * 1000;
/** Keep a bit more than a day so the 5h window is always fully covered. */
const RETENTION_MS = 25 * 3600 * 1000;

/**
 * Per-account request counting over a rolling 5h window, persisted in SQLite.
 * The pool steers *away* from accounts approaching their quota instead of
 * waiting for a 429, and excludes accounts that already hit the limit until
 * the window slides.
 */
export class QuotaTracker {
  /** Record one upstream request against an account. */
  record(accountId: string): void {
    this.recordModel(accountId);
  }

  /** Record one upstream request against an account and model. */
  recordModel(accountId: string, model?: string): void {
    try {
      getDb()
        .prepare('INSERT INTO usage_events (account_id, ts, model) VALUES (?, ?, ?)')
        .run(accountId, Date.now(), model ?? null);
    } catch {
      /* quota tracking must never break proxying */
    }
  }

  /** Store the cost/allowance metadata Zen reports for a request. */
  recordZenUsage(accountId: string, model: string | undefined, u: ZenUsage): void {
    try {
      getDb()
        .prepare(
          `INSERT INTO zen_usage (ts, account_id, model, allowance_usd, cost_usd, billing_source)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(Date.now(), accountId, model ?? null, u.allowance, u.cost, u.billingSource);
    } catch {
      /* ignore */
    }
  }

  /** Allowance dollars counted against an account in the trailing window. */
  allowance(accountId: string, windowMs: number = WINDOW_5H_MS): number {
    try {
      const row = getDb()
        .prepare('SELECT SUM(allowance_usd) AS total FROM zen_usage WHERE account_id = ? AND ts >= ?')
        .get(accountId, Date.now() - windowMs) as unknown as { total: number | null } | undefined;
      return row?.total ?? 0;
    } catch {
      return 0;
    }
  }

  /** Requests by this account in the trailing window. */
  usage(accountId: string, windowMs: number = WINDOW_5H_MS): number {
    try {
      const row = getDb()
        .prepare('SELECT COUNT(*) AS c FROM usage_events WHERE account_id = ? AND ts >= ?')
        .get(accountId, Date.now() - windowMs) as unknown as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  limit(): number {
    return getSettings().quota5hLimit;
  }

  /** Effective limit for an account: per-account override wins over the global. */
  limitFor(accountQuotaLimit?: number): number {
    return typeof accountQuotaLimit === 'number' && accountQuotaLimit > 0 ? accountQuotaLimit : this.limit();
  }

  isOverQuota(accountId: string, accountQuotaLimit?: number): boolean {
    const limit = this.limitFor(accountQuotaLimit);
    if (limit <= 0) return false; // non-positive limit disables enforcement
    return this.usage(accountId) >= limit;
  }

  isNearQuota(accountId: string, accountQuotaLimit?: number): boolean {
    const limit = this.limitFor(accountQuotaLimit);
    if (limit <= 0) return false;
    return this.usage(accountId) >= limit * 0.9;
  }

  /** Drop events older than the retention window. Called periodically. */
  prune(): void {
    try {
      const cutoff = Date.now() - RETENTION_MS;
      getDb().prepare('DELETE FROM usage_events WHERE ts < ?').run(cutoff);
      getDb().prepare('DELETE FROM zen_usage WHERE ts < ?').run(cutoff);
    } catch {
      /* ignore */
    }
  }
}
