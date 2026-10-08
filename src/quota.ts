import { getDb } from './db.js';
import { getSettings } from './settings.js';

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
    try {
      getDb().prepare('INSERT INTO usage_events (account_id, ts) VALUES (?, ?)').run(accountId, Date.now());
    } catch {
      /* quota tracking must never break proxying */
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

  isOverQuota(accountId: string): boolean {
    return this.usage(accountId) >= this.limit();
  }

  isNearQuota(accountId: string): boolean {
    return this.usage(accountId) >= this.limit() * 0.9;
  }

  /** Drop events older than the retention window. Called periodically. */
  prune(): void {
    try {
      getDb().prepare('DELETE FROM usage_events WHERE ts < ?').run(Date.now() - RETENTION_MS);
    } catch {
      /* ignore */
    }
  }
}
