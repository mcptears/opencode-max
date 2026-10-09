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
  /** Per-account quota override (undefined = global limit). */
  quotaLimit?: number;
  /** Per-account cooldown after 429 (undefined = global default). */
  cooldownPeriod?: number;
  /** Per-account upstream override (undefined = provider/global default). */
  baseUrl?: string;
  /** EMA of successful request latency in ms (0 when unknown). */
  avgLatencyMs: number;
  /** Requests currently in flight on this account. */
  inflight: number;
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
  /** In-flight request count per account (concurrency cap). */
  private readonly inflight = new Map<string, number>();

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
    for (const id of [...this.inflight.keys()]) {
      if (!known.has(id)) this.inflight.delete(id);
    }
    this.accounts = [...accounts].sort((a, b) => a.priority - b.priority);
  }

  /** Highest-priority usable account. Over-quota accounts are excluded; among the
   *  rest, the least-used one wins ties so load spreads before any 429 hits.
   *  With routingStrategy 'latency', the fastest-known account wins instead
   *  (unknown latency counts as 0 so new accounts get tried).
   *  Accounts at the concurrency cap are skipped. A successful acquire
   *  increments the in-flight count — pair it with release(). */
  acquire(provider?: string): AccountConfig | null {
    const now = Date.now();
    for (const [id, until] of this.coolingUntil) {
      if (until <= now) this.coolingUntil.delete(id);
    }
    const cap = getSettings().accountConcurrency;
    const pool = provider ? this.accounts.filter((a) => a.provider === provider) : this.accounts;
    const usable = pool.filter(
      (a) =>
        !this.invalid.has(a.id) &&
        !this.coolingUntil.has(a.id) &&
        !this.quota?.isOverQuota(a.id, a.quotaLimit) &&
        (cap <= 0 || (this.inflight.get(a.id) ?? 0) < cap),
    );
    const latency = (id: string): number => this.latencyEma.get(id) ?? 0;
    const usage = (id: string): number => this.quota?.usage(id) ?? 0;
    if (getSettings().routingStrategy === 'latency') {
      usable.sort((a, b) => latency(a.id) - latency(b.id) || a.priority - b.priority || usage(a.id) - usage(b.id));
    } else {
      usable.sort((a, b) => a.priority - b.priority || usage(a.id) - usage(b.id) || latency(a.id) - latency(b.id));
    }
    const picked = usable[0] ?? null;
    if (picked && cap > 0) this.inflight.set(picked.id, (this.inflight.get(picked.id) ?? 0) + 1);
    return picked;
  }

  /** Release an in-flight slot after the request finished (success or retry). */
  release(id: string): void {
    const n = this.inflight.get(id) ?? 0;
    if (n <= 1) this.inflight.delete(id);
    else this.inflight.set(id, n - 1);
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
   * True when accounts exist that are usable (not invalid/cooling/over-quota)
   * but every one is at the concurrency cap.
   */
  atCap(provider?: string): boolean {
    const cap = getSettings().accountConcurrency;
    if (cap <= 0) return false;
    const now = Date.now();
    const pool = provider ? this.accounts.filter((a) => a.provider === provider) : this.accounts;
    const candidates = pool.filter(
      (a) => !this.invalid.has(a.id) && (this.coolingUntil.get(a.id) ?? 0) <= now && !this.quota?.isOverQuota(a.id, a.quotaLimit),
    );
    return candidates.length > 0 && candidates.every((a) => (this.inflight.get(a.id) ?? 0) >= cap);
  }

  /** True when at least one usable account is under the concurrency cap. */
  hasCapacity(provider?: string): boolean {
    const cap = getSettings().accountConcurrency;
    const now = Date.now();
    const pool = provider ? this.accounts.filter((a) => a.provider === provider) : this.accounts;
    return pool.some(
      (a) =>
        !this.invalid.has(a.id) &&
        (this.coolingUntil.get(a.id) ?? 0) <= now &&
        !this.quota?.isOverQuota(a.id, a.quotaLimit) &&
        (cap <= 0 || (this.inflight.get(a.id) ?? 0) < cap),
    );
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
        quotaLimit: a.quotaLimit,
        cooldownPeriod: a.cooldownPeriod,
        baseUrl: a.baseUrl,
        avgLatencyMs: this.latencyEma.get(a.id) ?? 0,
        inflight: this.inflight.get(a.id) ?? 0,
      };
    });
  }
}
