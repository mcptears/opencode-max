import { ProxyAgent } from 'undici';

/** Hide credentials when displaying proxy URLs. */
export function redactProxy(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
      return u.toString();
    }
    return url;
  } catch {
    return url.replace(/:\/\/[^@/]+@/, '://***@');
  }
}

export interface ProxyHealth {
  proxy: string; // redacted
  healthy: boolean;
  fails: number;
  lastCheckedAgoMs: number;
}

/**
 * Round-robin egress proxy pool.
 * OpenCode Zen keys its rate-limit bucket on the raw egress IP (x-real-ip at the
 * edge; header spoofing is overwritten), so a real egress change requires routing
 * through a different proxy. Each rotation advances to the next proxy in the pool.
 *
 * Health checks periodically probe every proxy through its own dispatcher and
 * the rotation skips proxies that fail repeatedly, reviving them when they
 * recover.
 */
export class IpRotator {
  private proxies: string[];
  private index = 0;
  private readonly agentCache = new Map<string, ProxyAgent>();
  private readonly health = new Map<string, { healthy: boolean; fails: number; lastChecked: number }>();
  private timer?: NodeJS.Timeout;
  rotations = 0;
  /** Called on healthy<->unhealthy transitions (wired to metrics). */
  onHealthChange: ((proxy: string, healthy: boolean) => void) | null = null;

  constructor(proxies: string[]) {
    this.proxies = proxies;
  }

  get count(): number {
    return this.proxies.length;
  }

  /** Proxies eligible for rotation (healthy ones; all of them if none are healthy). */
  private eligible(): string[] {
    const healthy = this.proxies.filter((p) => this.health.get(p)?.healthy !== false);
    return healthy.length > 0 ? healthy : this.proxies;
  }

  /** Currently selected egress proxy URL, or null for a direct connection. */
  current(): string | null {
    const pool = this.eligible();
    return pool.length === 0 ? null : pool[this.index % pool.length];
  }

  /** Rotate to the next proxy. Returns the newly selected proxy (null = direct). */
  rotate(): string | null {
    const pool = this.eligible();
    if (pool.length === 0) return null;
    this.index = (this.index + 1) % pool.length;
    this.rotations += 1;
    return this.current();
  }

  /** Hot-swap the proxy list (dashboard edits). Keeps the rotation position sane. */
  setProxies(proxies: string[]): void {
    this.proxies = proxies;
    this.agentCache.clear();
    for (const key of [...this.health.keys()]) {
      if (!proxies.includes(key)) this.health.delete(key);
    }
    if (this.index >= this.proxies.length) this.index = 0;
  }

  dispatcherFor(proxy: string | null): ProxyAgent | undefined {
    if (!proxy) return undefined;
    let agent = this.agentCache.get(proxy);
    if (!agent) {
      agent = new ProxyAgent(proxy);
      this.agentCache.set(proxy, agent);
    }
    return agent;
  }

  status(): { proxies: number; currentIndex: number; current: string | null; rotations: number; health: ProxyHealth[] } {
    const now = Date.now();
    return {
      proxies: this.proxies.length,
      currentIndex: this.index,
      current: this.current(),
      rotations: this.rotations,
      health: this.proxies.map((p) => {
        const h = this.health.get(p);
        return {
          proxy: redactProxy(p),
          healthy: h?.healthy !== false,
          fails: h?.fails ?? 0,
          lastCheckedAgoMs: h ? Math.max(0, now - h.lastChecked) : -1,
        };
      }),
    };
  }

  /** Start periodic health probing. Two consecutive failures mark a proxy down. */
  startHealthChecks(intervalMs = 60000, target = 'https://opencode.ai/zen/v1/models'): void {
    if (this.timer || this.proxies.length === 0) return;
    const run = (): void => {
      void this.checkAll(target);
    };
    run();
    this.timer = setInterval(run, Math.max(10000, intervalMs));
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stopHealthChecks(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkAll(target = 'https://opencode.ai/zen/v1/models'): Promise<void> {
    await Promise.allSettled(this.proxies.map((p) => this.checkOne(p, target)));
  }

  private async checkOne(proxy: string, target: string): Promise<void> {
    const st = this.health.get(proxy) ?? { healthy: true, fails: 0, lastChecked: 0 };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(target, {
          dispatcher: this.dispatcherFor(proxy),
          signal: controller.signal,
        } as RequestInit & { dispatcher?: unknown });
        if (res.status >= 500) throw new Error(`health check status ${res.status}`);
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
      } finally {
        clearTimeout(timer);
      }
      if (!st.healthy) {
        st.healthy = true;
        try {
          this.onHealthChange?.(proxy, true);
        } catch {
          /* ignore */
        }
      }
      st.fails = 0;
    } catch {
      st.fails += 1;
      if (st.healthy && st.fails >= 2) {
        st.healthy = false;
        try {
          this.onHealthChange?.(proxy, false);
        } catch {
          /* ignore */
        }
      }
    }
    st.lastChecked = Date.now();
    this.health.set(proxy, st);
  }
}
