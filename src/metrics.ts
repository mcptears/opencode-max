export interface MetricEvent {
  t: number;
  kind: 'request' | 'rate_limited' | 'rotated' | 'account_added' | 'account_removed' | 'proxy_added' | 'proxy_removed' | 'settings' | 'error';
  detail: string;
}

const MAX_EVENTS = 200;

/** Tiny in-memory metrics recorder for the dashboard. No DB, no deps. */
export class Metrics {
  readonly startedAt = Date.now();
  requests = 0;
  successes = 0;
  rateLimited = 0;
  rotations = 0;
  retries = 0;
  readonly perAccount = new Map<string, number>();
  private readonly events: MetricEvent[] = [];

  record(kind: MetricEvent['kind'], detail: string): void {
    this.events.unshift({ t: Date.now(), kind, detail });
    if (this.events.length > MAX_EVENTS) this.events.pop();
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

  rotated(proxy: string | null): void {
    this.rotations += 1;
    this.record('rotated', `egress rotated → ${proxy ?? 'direct'}`);
  }

  retried(): void {
    this.retries += 1;
  }

  summary(): Record<string, unknown> {
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      requests: this.requests,
      successes: this.successes,
      rateLimited: this.rateLimited,
      rotations: this.rotations,
      retries: this.retries,
      perAccount: Object.fromEntries(this.perAccount),
    };
  }

  recentEvents(limit = 50): MetricEvent[] {
    return this.events.slice(0, limit);
  }
}
