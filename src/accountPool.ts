import type { AccountConfig } from './config.js';
import { getSettings } from './settings.js';
import type { QuotaTracker } from './quota.js';

export interface AccountStatus {
  id: string;
  name: string;
  provider: string;
  priority: number;
  state: 'active' | 'cooling_down' | 'invalid';
  cooldownEndsInMs: number;
  /** Requests in the trailing 5h window (quota tracking). */
  usage5h: number;
  /** EMA of successful request latency in ms (0 when unknown). */
  avgLatencyMs: number;
}

/**
 * Priority-ordered token pool with cooldown tracking.
 * Mirrors the approach of rahadiana/opencode-multi-account: accounts are tried
 * P1 -> P2 -> P3; a 429 parks the account for its cooldownPeriod, after which
 * it automatically rejoins the pool.
 */
export class AccountPool {
  private accounts: AccountConfig[];
  private readonly coolingUntil = new Map<string, number>();
  /** Keys proven dead (401 / invalid-key 403). Skipped until manually reset. */
  private readonly invalid = new Set<string>();
  private quota: QuotaTracker | null = null;
  /** Exponential moving average of successful request latency per account (ms). */
  private readonly latencyEma = new Map<string, number>();

  constructor(accounts: AccountConfig[], quota?: QuotaTracker) {
    this.accounts = [...accounts].sort((a, b) => a.priority - b.priority);
    if (quota) this.quota = quota;
  }

  /** Attach the quota tracker (wired at startup). */
  setQuotaTracker(quota: QuotaTracker | null): void {
    this.quota = quota;
  }

  /** Hot-swap the pool (dashboard edits). Cooling state is preserved by account id. */
  replace(accounts: AccountConfig[]): void {
    const known = new Set(accounts.map((a) => a.id));
    for (const id of [...this.coolingUntil.keys()]) {
      if (!known.has(id)) this.coolingUntil.delete(id);
    }
    for (const id of [...this.invalid]) {
      if (!known.has(id)) this.invalid.delete(id);
    }
    this.accounts = [...accounts].sort((a, b) => a.priority - b.priority);
  }

  /** Highest-priority usable account. Over-quota accounts are excluded; among the
   *  rest, the least-used one wins ties so load spreads before any 429 hits.
   *  With routingStrategy 'latency', the fastest-known account wins instead
   *  (unknown latency counts as 0 so new accounts get tried). */
  acquire(provider?: string): AccountConfig | null {
    const now = Date.now();
    for (const [id, until] of this.coolingUntil) {
      if (until <= now) this.coolingUntil.delete(id);
    }
    const pool = provider ? this.accounts.filter((a) => a.provider === provider) : this.accounts;
    const usable = pool.filter(
      (a) => !this.invalid.has(a.id) && !this.coolingUntil.has(a.id) && !this.quota?.isOverQuota(a.id),
    );
    const latency = (id: string): number => this.latencyEma.get(id) ?? 0;
    const usage = (id: string): number => this.quota?.usage(id) ?? 0;
    if (getSettings().routingStrategy === 'latency') {
      usable.sort((a, b) => latency(a.id) - latency(b.id) || a.priority - b.priority || usage(a.id) - usage(b.id));
    } else {
      usable.sort((a, b) => a.priority - b.priority || usage(a.id) - usage(b.id) || latency(a.id) - latency(b.id));
    }
    return usable[0] ?? null;
  }

  /** Number of configured accounts, optionally filtered by provider. */
  count(provider?: string): number {
    return provider ? this.accounts.filter((a) => a.provider === provider).length : this.accounts.length;
  }

  /** Record a successful request latency (EMA, α=0.3). */
  recordLatency(id: string, ms: number): void {
    const prev = this.latencyEma.get(id);
    this.latencyEma.set(id, prev === undefined ? ms : Math.round(prev * 0.7 + ms * 0.3));
  }

  /** EMA latency in ms, or null when the account has no successful requests yet. */
  latencyOf(id: string): number | null {
    return this.latencyEma.get(id) ?? null;
  }

  /**
   * ms until the soonest cooling account of this provider becomes usable
   * again; 0 when nothing is cooling (or everything is quota-parked, whose
   * window slide we can't predict).
   */
  nextAvailableIn(provider?: string): number {
    const now = Date.now();
    let min = 0;
    for (const [id, until] of this.coolingUntil) {
      if (until <= now) continue;
      const acc = this.accounts.find((a) => a.id === id);
      if (!acc || this.invalid.has(id)) continue;
      if (provider && acc.provider !== provider) continue;
      const wait = until - now;
      if (min === 0 || wait < min) min = wait;
    }
    return min;
  }

  /** Park an account after a 429/quota hit. */
  markLimited(id: string, cooldownMs?: number): void {
    const acc = this.accounts.find((a) => a.id === id);
    this.coolingUntil.set(id, Date.now() + (cooldownMs ?? acc?.cooldownPeriod ?? getSettings().defaultCooldownMs));
  }

  /** Mark a key as dead (401 / invalid-key 403). Skipped until reset. */
  markInvalid(id: string): void {
    this.invalid.add(id);
    this.coolingUntil.delete(id);
  }

  /** Re-admit a key (dashboard reset after fixing it). */
  clearInvalid(id: string): void {
    this.invalid.delete(id);
    this.coolingUntil.delete(id);
  }

  isInvalid(id: string): boolean {
    return this.invalid.has(id);
  }

  /** True when accounts exist but every one is flagged invalid. */
  allInvalid(provider?: string): boolean {
    const pool = provider ? this.accounts.filter((a) => a.provider === provider) : this.accounts;
    return pool.length > 0 && pool.every((a) => this.invalid.has(a.id));
  }

  exhausted(provider?: string): boolean {
    return this.acquire(provider) === null;
  }

  status(): AccountStatus[] {
    const now = Date.now();
    return this.accounts.map((a) => {
      const until = this.coolingUntil.get(a.id) ?? 0;
      const state = this.invalid.has(a.id) ? 'invalid' : until > now ? 'cooling_down' : 'active';
      return {
        id: a.id,
        name: a.name,
        provider: a.provider,
        priority: a.priority,
        state,
        cooldownEndsInMs: state === 'cooling_down' ? Math.max(0, until - now) : 0,
        usage5h: this.quota?.usage(a.id) ?? 0,
        avgLatencyMs: this.latencyEma.get(a.id) ?? 0,
      };
    });
  }
}
