import { ProxyAgent } from 'undici';

/**
 * Round-robin egress proxy pool.
 * OpenCode Zen keys its rate-limit bucket on the raw egress IP (x-real-ip at the
 * edge; header spoofing is overwritten), so a real egress change requires routing
 * through a different proxy. Each rotation advances to the next proxy in the pool.
 */
export class IpRotator {
  private readonly proxies: string[];
  private index = 0;
  private readonly agentCache = new Map<string, ProxyAgent>();
  rotations = 0;

  constructor(proxies: string[]) {
    this.proxies = proxies;
  }

  get count(): number {
    return this.proxies.length;
  }

  /** Currently selected egress proxy URL, or null for a direct connection. */
  current(): string | null {
    return this.proxies.length === 0 ? null : this.proxies[this.index % this.proxies.length];
  }

  /** Rotate to the next proxy. Returns the newly selected proxy (null = direct). */
  rotate(): string | null {
    if (this.proxies.length === 0) return null;
    this.index = (this.index + 1) % this.proxies.length;
    this.rotations += 1;
    return this.current();
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

  status(): { proxies: number; currentIndex: number; current: string | null; rotations: number } {
    return { proxies: this.proxies.length, currentIndex: this.index, current: this.current(), rotations: this.rotations };
  }
}
