import { describe, it, expect } from 'vitest';
import { scrapeAll, type ScrapeProgress, type ProxyProvider } from '../scraper.js';

const dead: ProxyProvider = { id: 'dead', name: 'Dead list', url: 'http://127.0.0.1:1/list.txt', format: 'text', enabled: true };
const off: ProxyProvider = { id: 'off', name: 'Off list', url: 'http://127.0.0.1:1/x.txt', format: 'text', enabled: false };

describe('scrapeAll progress', () => {
  it('emits fetching then testing progress events', async () => {
    const events: ScrapeProgress[] = [];
    const result = await scrapeAll([dead, off], { maxTest: 10 }, (p) => events.push(p));

    // Only the enabled provider was attempted; the dead one fails fast (connection refused).
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].ok).toBe(false);
    expect(result.tested).toBe(0);

    expect(events.length).toBeGreaterThan(0);
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe('fetching');
    expect(phases[phases.length - 1]).toBe('testing');

    const first = events[0];
    expect(first.providersTotal).toBe(1);
    expect(first.currentProvider).toBe('Dead list');

    // Provider results accumulate in progress events.
    const withResults = events.find((e) => e.providerResults.length > 0);
    expect(withResults).toBeDefined();
    expect(withResults!.providerResults[0]).toMatchObject({ id: 'dead', ok: false, found: 0 });

    const last = events[events.length - 1];
    expect(last.totalToTest).toBe(0);
    expect(last.working).toBe(0);
  });

  it('never breaks the run when the progress callback throws', async () => {
    const result = await scrapeAll([dead], { maxTest: 5 }, () => {
      throw new Error('boom');
    });
    expect(result.providers).toHaveLength(1);
  });
});
