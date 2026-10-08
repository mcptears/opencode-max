import { Agent, ProxyAgent } from 'undici';

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

export type EgressFamilyMode = 'auto' | '4' | '6';

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
 *
 * When NO proxies are configured, egress is direct and the IP family itself can
 * be rotated: Zen treats IPv4 and IPv6 as separate buckets, so alternating the
 * connection family on a dual-stack host doubles the effective quota.
 */
export class IpRotator {
  private proxies: string[];
  private index = 0;
  private readonly agentCache = new Map<string, ProxyAgent>();
  private readonly directAgentCache = new Map<number, Agent>();
  private readonly health = new Map<string, { healthy: boolean; fails: number; lastChecked: number }>();
  private timer?: NodeJS.Timeout;
  private familyMode: EgressFamilyMode = 'auto';
  private dualStack = false;
  private family: 4 | 6 = 4;
  rotations = 0;
  /** Called on healthy<->unhealthy transitions (wired to metrics). */
  onHealthChange: ((proxy: string, healthy: boolean) => void) | null = null;

  constructor(proxies: string[]) {
    this.proxies = proxies;
  }

  /** Configure family rotation: 'auto' alternates v4/v6 on dual-stack hosts. */
  configureEgress(opts: { familyMode?: EgressFamilyMode; dualStack?: boolean }): void {
    if (opts.familyMode) this.familyMode = opts.familyMode;
    if (opts.dualStack !== undefined) this.dualStack = opts.dualStack;
  }

  /** Effective IP family for direct egress right now. */
  currentFamily(): 4 | 6 {
    if (this.familyMode === '4' || this.familyMode === '6') return Number(this.familyMode) as 4 | 6;
    return this.dualStack ? this.family : 4;
  }

  /** Human-readable current egress for logs and events (credentials redacted). */
  egressLabel(): string {
    const p = this.current();
    return p ? redactProxy(p) : `direct (IPv${this.currentFamily()})`;
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
    if (pool.length === 0) {
      // Direct egress: rotate the IP family itself when it buys a fresh bucket.
      if (this.familyMode === 'auto' && this.dualStack) {
        this.family = this.family === 4 ? 6 : 4;
        this.rotations += 1;
      }
      return null;
    }
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

  /** Dispatcher for one upstream request: a proxy agent, or a direct agent pinned to the current IP family. */
  dispatcherFor(proxy: string | null, family: 4 | 6 = 4): unknown {
    if (proxy) {
      let agent = this.agentCache.get(proxy);
      if (!agent) {
        agent = new ProxyAgent(proxy);
        this.agentCache.set(proxy, agent);
      }
      return agent;
    }
    let direct = this.directAgentCache.get(family);
    if (!direct) {
      direct = new Agent({ connect: { family } } as never);
      this.directAgentCache.set(family, direct);
    }
    return direct;
  }

  status(): {
    proxies: number;
    currentIndex: number;
    current: string | null;
    rotations: number;
    family: 4 | 6;
    familyMode: EgressFamilyMode;
    dualStack: boolean;
    health: ProxyHealth[];
  } {
    const now = Date.now();
    return {
      proxies: this.proxies.length,
      currentIndex: this.index,
      current: this.current(),
      rotations: this.rotations,
      family: this.currentFamily(),
      familyMode: this.familyMode,
      dualStack: this.dualStack,
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
