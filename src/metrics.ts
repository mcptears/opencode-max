import { getDb } from './db.js';

export interface MetricEvent {
  t: number;
  kind: 'request' | 'rate_limited' | 'rotated' | 'account_added' | 'account_removed' | 'proxy_added' | 'proxy_removed' | 'settings' | 'error';
  detail: string;
}

export interface HistoryBucket {
  hour: number; // epoch ms, hour-aligned
  requests: number;
  errors: number;
  rateLimited: number;
  rotations: number;
}

const MAX_EVENTS = 200;
/** Keep 30 days of history; prune on startup. */
const HISTORY_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** Metrics recorder: hot counters in memory, events + request log in SQLite. */
export class Metrics {
  readonly startedAt = Date.now();
  requests = 0;
  successes = 0;
  rateLimited = 0;
  rotations = 0;
  retries = 0;
  tokensSaved = 0;
  readonly perAccount = new Map<string, number>();
  private readonly events: MetricEvent[] = [];

  constructor() {
    // Restore recent events so the feed survives restarts.
    try {
      const db = getDb();
      const rows = db
        .prepare('SELECT ts AS t, kind, detail FROM metric_events ORDER BY id DESC LIMIT ?')
        .all(MAX_EVENTS) as unknown as MetricEvent[];
      this.events.push(...rows.reverse());
      const cutoff = Date.now() - HISTORY_RETENTION_MS;
      db.prepare('DELETE FROM metric_events WHERE ts < ?').run(cutoff);
      db.prepare('DELETE FROM request_log WHERE ts < ?').run(cutoff);
    } catch {
      /* metrics must never break the proxy */
    }
  }

  record(kind: MetricEvent['kind'], detail: string): void {
    const ev = { t: Date.now(), kind, detail };
    this.events.unshift(ev);
    if (this.events.length > MAX_EVENTS) this.events.pop();
    try {
      getDb().prepare('INSERT INTO metric_events (ts, kind, detail) VALUES (?, ?, ?)').run(ev.t, kind, detail);
    } catch {
      /* ignore */
    }
  }

  hit(accountId: string): void {
    this.requests += 1;
    this.perAccount.set(accountId, (this.perAccount.get(accountId) ?? 0) + 1);
  }

  ok(): void {
    this.successes += 1;
  }

  limited(accountId: string): void {
    this.rateLimited += 1;
    this.record('rate_limited', `429/quota on ${accountId} — token parked, IP rotated`);
  }

  rotated(label: string): void {
    this.rotations += 1;
    this.record('rotated', `egress rotated → ${label}`);
  }

  retried(): void {
    this.retries += 1;
  }

  /** Estimated tokens saved by the token saver (chars/4 heuristic). */
  addTokensSaved(n: number): void {
    this.tokensSaved += n;
  }

  /** Log one completed proxied request (called once per forward()). */
  logRequest(accountId: string, status: number, latencyMs: number, model?: string): void {
    try {
      getDb()
        .prepare('INSERT INTO request_log (ts, account_id, status, latency_ms, model) VALUES (?, ?, ?, ?, ?)')
        .run(Date.now(), accountId, status, Math.round(latencyMs), model ?? null);
    } catch {
      /* ignore */
    }
  }

  /** Hourly buckets for the last N hours (dashboard chart). */
  history(hours = 24): HistoryBucket[] {
    const since = Date.now() - hours * 3600 * 1000;
    const buckets = new Map<number, HistoryBucket>();
    const bucket = (ts: number): HistoryBucket => {
      const hour = Math.floor(ts / 3600000) * 3600000;
      let b = buckets.get(hour);
      if (!b) {
        b = { hour, requests: 0, errors: 0, rateLimited: 0, rotations: 0 };
        buckets.set(hour, b);
      }
      return b;
    };
    try {
      const db = getDb();
      const reqs = db
        .prepare('SELECT ts, status FROM request_log WHERE ts >= ?')
        .all(since) as unknown as { ts: number; status: number }[];
      for (const r of reqs) {
        const b = bucket(r.ts);
        b.requests += 1;
        if (r.status >= 500 || r.status === 0) b.errors += 1;
      }
      const evs = db
        .prepare("SELECT ts, kind FROM metric_events WHERE ts >= ? AND kind IN ('rate_limited','rotated')")
        .all(since) as unknown as { ts: number; kind: string }[];
      for (const e of evs) {
        const b = bucket(e.ts);
        if (e.kind === 'rate_limited') b.rateLimited += 1;
        else b.rotations += 1;
      }
    } catch {
      /* ignore */
    }
    return [...buckets.values()].sort((a, b) => a.hour - b.hour);
  }

  summary(): Record<string, unknown> {
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      requests: this.requests,
      successes: this.successes,
      rateLimited: this.rateLimited,
      rotations: this.rotations,
      retries: this.retries,
      tokensSaved: this.tokensSaved,
      perAccount: Object.fromEntries(this.perAccount),
    };
  }

  recentEvents(limit = 50): MetricEvent[] {
    return this.events.slice(0, limit);
  }
}
