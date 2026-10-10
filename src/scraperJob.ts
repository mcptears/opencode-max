import type { IpRotator } from './ipRotator.js';
import type { Metrics } from './metrics.js';
import { loadProviders, scrapeAll, type ScrapeProgress, type ScrapeResult } from './scraper.js';
import { readProxies, writeProxies } from './store.js';

export interface ScraperJobState {
  running: boolean;
  progress: ScrapeProgress | null;
  result: ScrapeResult | null;
  lastRunAt: number | null;
  lastRunAuto: boolean;
}

/**
 * Proxy scrape job shared by the dashboard "Scrape now" button and the
 * scheduled auto-scraper. Scrapes all enabled free-proxy providers, tests
 * candidates, and appends the working ones to the pool.
 */
export class ScraperJob {
  private state: ScraperJobState = { running: false, progress: null, result: null, lastRunAt: null, lastRunAuto: false };

  constructor(
    private readonly rotator: IpRotator,
    private readonly metrics: Metrics,
  ) {}

  status(): ScraperJobState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : null };
  }

  /**
   * Run a scrape in the background. Returns false when one is already running.
   * `auto` marks scheduler-triggered runs in the status/events.
   */
  start(auto = false): boolean {
    if (this.state.running) return false;
    this.state = { running: true, progress: null, result: null, lastRunAt: this.state.lastRunAt, lastRunAuto: auto };
    this.metrics.record('settings', auto ? 'scheduled proxy scrape started' : 'proxy scrape started');
    void (async () => {
      try {
        const result = await scrapeAll(loadProviders(), {}, (progress) => {
          if (this.state.running) this.state.progress = progress;
        });
        const current = readProxies();
        const known = new Set(current);
        const fresh = result.working.filter((p) => !known.has(p));
        if (fresh.length > 0) {
          const next = [...current, ...fresh];
          writeProxies(next);
          this.rotator.setProxies(next);
        }
        this.state = { running: false, progress: null, result, lastRunAt: Date.now(), lastRunAuto: auto };
        this.metrics.record(
          'proxy_added',
          `proxy scrape finished: ${result.working.length} working of ${result.tested} tested (${fresh.length} new)`,
        );
      } catch (e) {
        this.state = { running: false, progress: null, result: null, lastRunAt: this.state.lastRunAt, lastRunAuto: auto };
        this.metrics.record('error', `proxy scrape failed: ${String(e).slice(0, 120)}`);
      }
    })();
    return true;
  }
}
