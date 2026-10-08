import type { AccountConfig } from './config.js';

export interface AccountStatus {
  id: string;
  name: string;
  provider: string;
  priority: number;
  state: 'active' | 'cooling_down';
  cooldownEndsInMs: number;
}

/**
 * Priority-ordered token pool with cooldown tracking.
 * Mirrors the approach of rahadiana/opencode-multi-account: accounts are tried
 * P1 -> P2 -> P3; a 429 parks the account for its cooldownPeriod, after which
 * it automatically rejoins the pool.
 */
export class AccountPool {
  private readonly accounts: AccountConfig[];
  private readonly coolingUntil = new Map<string, number>();
  private readonly defaultCooldownMs: number;

  constructor(accounts: AccountConfig[], defaultCooldownMs: number) {
    this.accounts = accounts;
    this.defaultCooldownMs = defaultCooldownMs;
  }

  /** Highest-priority account for the provider that is not cooling down. */
  acquire(provider?: string): AccountConfig | null {
    const now = Date.now();
    for (const [id, until] of this.coolingUntil) {
      if (until <= now) this.coolingUntil.delete(id);
    }
    const pool = provider ? this.accounts.filter((a) => a.provider === provider) : this.accounts;
    return pool.find((a) => !this.coolingUntil.has(a.id)) ?? null;
  }

  /** Park an account after a 429/quota hit. */
  markLimited(id: string, cooldownMs?: number): void {
    const acc = this.accounts.find((a) => a.id === id);
    this.coolingUntil.set(id, Date.now() + (cooldownMs ?? acc?.cooldownPeriod ?? this.defaultCooldownMs));
  }

  exhausted(provider?: string): boolean {
    return this.acquire(provider) === null;
  }

  status(): AccountStatus[] {
    const now = Date.now();
    return this.accounts.map((a) => {
      const until = this.coolingUntil.get(a.id) ?? 0;
      return {
        id: a.id,
        name: a.name,
        provider: a.provider,
        priority: a.priority,
        state: until > now ? 'cooling_down' : 'active',
        cooldownEndsInMs: Math.max(0, until - now),
      };
    });
  }
}
