import { describe, it, expect } from 'vitest';
import { IpRotator, redactProxy } from '../ipRotator.js';

function down(r: IpRotator, proxy: string): void {
  (r as unknown as { health: Map<string, { healthy: boolean; fails: number; lastChecked: number }> }).health.set(
    proxy,
    { healthy: false, fails: 2, lastChecked: Date.now() },
  );
}

describe('IpRotator', () => {
  it('round-robins through proxies', () => {
    const r = new IpRotator(['http://a:1', 'http://b:2', 'http://c:3']);
    expect(r.current()).toBe('http://a:1');
    expect(r.rotate()).toBe('http://b:2');
    expect(r.rotate()).toBe('http://c:3');
    expect(r.rotate()).toBe('http://a:1');
    expect(r.rotations).toBe(3);
  });

  it('returns null with no proxies (direct egress)', () => {
    const r = new IpRotator([]);
    expect(r.current()).toBeNull();
    expect(r.rotate()).toBeNull();
  });

  it('skips unhealthy proxies in rotation', () => {
    const r = new IpRotator(['http://a:1', 'http://b:2', 'http://c:3']);
    down(r, 'http://b:2');
    expect(r.rotate()).toBe('http://c:3');
    expect(r.rotate()).toBe('http://a:1');
  });

  it('falls back to all proxies when every one is down', () => {
    const r = new IpRotator(['http://a:1', 'http://b:2']);
    down(r, 'http://a:1');
    down(r, 'http://b:2');
    expect(r.current()).not.toBeNull();
  });

  it('alternates IP family on dual-stack direct egress', () => {
    const r = new IpRotator([]);
    r.configureEgress({ familyMode: 'auto', dualStack: true });
    expect(r.currentFamily()).toBe(4);
    r.rotate();
    expect(r.currentFamily()).toBe(6);
    expect(r.egressLabel()).toBe('direct (IPv6)');
    r.rotate();
    expect(r.currentFamily()).toBe(4);
  });

  it('does not flip family on single-stack hosts', () => {
    const r = new IpRotator([]);
    r.configureEgress({ familyMode: 'auto', dualStack: false });
    r.rotate();
    expect(r.currentFamily()).toBe(4);
    expect(r.rotations).toBe(0);
  });

  it('honours a pinned family', () => {
    const r = new IpRotator([]);
    r.configureEgress({ familyMode: '6', dualStack: false });
    expect(r.currentFamily()).toBe(6);
  });

  it('redacts credentials in status output', () => {
    expect(redactProxy('http://user:pass@host:8080')).toBe('http://***@host:8080/');
    expect(redactProxy('http://host:8080')).toBe('http://host:8080');
  });
});
