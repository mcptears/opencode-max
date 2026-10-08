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
   *  rest, the least-used one wins ties so load spreads before any 429 hits. */
  acquire(provider?: string): AccountConfig | null {
    const now = Date.now();
    for (const [id, until] of this.coolingUntil) {
      if (until <= now) this.coolingUntil.delete(id);
    }
    const pool = provider ? this.accounts.filter((a) => a.provider === provider) : this.accounts;
    const usable = pool.filter(
      (a) => !this.invalid.has(a.id) && !this.coolingUntil.has(a.id) && !this.quota?.isOverQuota(a.id),
    );
    usable.sort((a, b) => a.priority - b.priority || (this.quota?.usage(a.id) ?? 0) - (this.quota?.usage(b.id) ?? 0));
    return usable[0] ?? null;
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
      };
    });
  }
}
