import type { Metrics } from './metrics.js';
import type { AccountPool } from './accountPool.js';

/**
 * Prometheus text exposition format for the /metrics endpoint.
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 */

function escLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function counter(name: string, help: string, value: number, labels = ''): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name}${labels} ${value}\n`;
}

function gauge(name: string, help: string, value: number, labels = ''): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${labels} ${value}\n`;
}

/** Render current counters Gauges in Prometheus text format (no secrets). */
export function renderPrometheus(metrics: Metrics, pool?: AccountPool): string {
  const out: string[] = [];
  out.push(counter('opencode_max_requests_total', 'Total proxied requests', metrics.requests));
  out.push(counter('opencode_max_successes_total', 'Requests that reached upstream without retryable error', metrics.successes));
  out.push(counter('opencode_max_rate_limited_total', 'Upstream 429 / quota hits', metrics.rateLimited));
  out.push(counter('opencode_max_rotations_total', 'Egress IP rotations', metrics.rotations));
  out.push(counter('opencode_max_retries_total', 'Transparent upstream retries', metrics.retries));
  out.push(counter('opencode_max_failovers_total', 'Cross-provider and model fallbacks', metrics.failovers));
  out.push(counter('opencode_max_tokens_saved_total', 'Approximate tokens saved by the token saver', metrics.tokensSaved));
  out.push(
    gauge(
      'opencode_max_uptime_seconds',
      'Process uptime in seconds',
      Math.floor((Date.now() - metrics.startedAt) / 1000),
    ),
  );
  for (const [accountId, count] of metrics.perAccount) {
    out.push(
      counter(
        'opencode_max_account_requests_total',
        'Proxied requests per account',
        count,
        `{account="${escLabel(accountId)}"}`,
      ),
    );
  }
  if (pool) {
    for (const a of pool.status()) {
      out.push(
        gauge(
          'opencode_max_account_inflight',
          'Currently in-flight requests per account',
          a.inflight,
          `{account="${escLabel(a.id)}"}`,
        ),
      );
    }
  }
  return out.join('');
}
