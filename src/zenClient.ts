import { setTimeout as sleep } from 'node:timers/promises';
import type { AccountPool } from './accountPool.js';
import type { IpRotator } from './ipRotator.js';
import type { Metrics } from './metrics.js';
import { sanitizeHeaders, sanitizePayload } from './sanitizer.js';
import { getSettings } from './settings.js';
import type { SessionManager } from './sessionManager.js';

export interface ForwardRequest {
  method: string;
  /** Path on the upstream, e.g. "/chat/completions". */
  path: string;
  /** Raw query string including leading "?", or "". */
  query: string;
  headers: Record<string, string | string[] | undefined>;
  bodyText?: string;
  /** Account pool selector (defaults to all providers). */
  provider?: string;
  signal?: AbortSignal;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}

/** Statuses worth a transparent retry: 429/quota plus transient 5xx. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Body patterns that mean "this key is dead" (vs quota/rate-limit 403s). */
const INVALID_KEY_PATTERNS = /invalid[_\s-]?api[_\s-]?key|invalid[_\s-]?key|unauthorized|bad[_\s-]?credentials|incorrect[_\s-]?api[_\s-]?key/i;
const QUOTA_PATTERNS = /quota|rate[_\s-]?limit|too[_\s-]?many[_\s-]?requests|insufficient/i;

function backoff(attempt: number): number {
  const s = getSettings();
  const exp = Math.min(s.retryMaxMs, s.retryBaseMs * 2 ** attempt);
  return Math.floor(exp * (0.8 + Math.random() * 0.4)); // ±20% jitter
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Forwards requests to OpenCode Zen with the combined rotation strategy:
 * attach a pool token -> strip identity/telemetry -> on 429 park the token,
 * rotate the egress IP, mint a fresh session id, and retry with backoff.
 */
export class ZenClient {
  constructor(
    private readonly pool: AccountPool,
    private readonly rotator: IpRotator,
    private readonly sessions: SessionManager,
    private readonly metrics?: Metrics,
  ) {}

  async forward(req: ForwardRequest): Promise<ForwardResult> {
    let lastError: unknown = null;
    const maxRetries = getSettings().maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const account = this.pool.acquire(req.provider);
      if (!account) {
        const msg = this.pool.allInvalid(req.provider)
          ? 'all API keys are flagged invalid — fix them in the dashboard and reset'
          : 'all accounts exhausted (rate-limited or none configured)';
        throw httpError(503, msg);
      }
      this.metrics?.hit(account.id);

      const proxy = this.rotator.current();
      const base = (account.baseUrl ?? getSettings().upstreamBase).replace(/\/+$/, '');
      const url = `${base}${req.path}${req.query}`;

      const headers = sanitizeHeaders(req.headers);
      headers['authorization'] = `Bearer ${account.apiKey}`;
      headers['x-opencode-session'] = this.sessions.id;
      headers['accept'] = headers['accept'] ?? 'text/event-stream';

      let body: string | undefined;
      if (req.bodyText && req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = JSON.stringify(sanitizePayload(JSON.parse(req.bodyText), this.sessions.id));
          headers['content-type'] = 'application/json';
        } catch {
          body = req.bodyText; // non-JSON bodies pass through untouched
        }
      }

      let upstream: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), getSettings().requestTimeoutMs);
        const onAbort = (): void => controller.abort();
        req.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          upstream = await fetch(url, {
            method: req.method,
            headers,
            body,
            dispatcher: this.rotator.dispatcherFor(proxy),
            signal: controller.signal,
          } as RequestInit & { dispatcher?: unknown });
        } finally {
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onAbort);
        }
      } catch (e) {
        lastError = e; // network-level failure: back off and retry
        await sleep(backoff(attempt));
        continue;
      }

      if (!RETRYABLE_STATUS.has(upstream.status)) {
        // Dead-key detection: 401, or a 403 that smells like a bad key (not quota).
        if (upstream.status === 401 || upstream.status === 403) {
          let probe = '';
          try {
            probe = await upstream.clone().text();
          } catch {
            /* ignore */
          }
          const looksInvalid =
            upstream.status === 401 ||
            (INVALID_KEY_PATTERNS.test(probe) && !QUOTA_PATTERNS.test(probe));
          if (looksInvalid) {
            this.pool.markInvalid(account.id);
            this.metrics?.record('error', `invalid API key on ${account.id} — parked until reset`);
            try {
              await upstream.body?.cancel();
            } catch {
              /* ignore */
            }
            lastError = new Error(`invalid API key on account ${account.id}`);
            continue; // fail over immediately: no backoff, no IP rotation needed
          }
        }
        this.metrics?.ok();
        return this.toResult(upstream);
      }

      // 429 / quota / transient 5xx: park the token, rotate egress IP,
      // mint a fresh session id, then retry transparently.
      this.pool.markLimited(account.id);
      const newProxy = this.rotator.rotate();
      this.sessions.rotate();
      this.metrics?.limited(account.id);
      this.metrics?.rotated(newProxy);
      this.metrics?.retried();
      try {
        await upstream.body?.cancel();
      } catch {
        /* ignore */
      }
      lastError = new Error(`upstream ${upstream.status} on account ${account.id}`);
      await sleep(backoff(attempt));
    }

    throw httpError(502, `upstream unreachable after ${maxRetries + 1} attempts: ${String(lastError)}`);
  }

  private toResult(upstream: Response): ForwardResult {
    const headers: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) {
        headers[k] = v;
      }
    });
    return { status: upstream.status, headers, body: upstream.body };
  }
}
