import { setTimeout as sleep } from 'node:timers/promises';
import type { AccountPool } from './accountPool.js';
import { CONFIG } from './config.js';
import type { IpRotator } from './ipRotator.js';
import { sanitizeHeaders, sanitizePayload } from './sanitizer.js';
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

function backoff(attempt: number): number {
  const exp = Math.min(CONFIG.retryMaxMs, CONFIG.retryBaseMs * 2 ** attempt);
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
  ) {}

  async forward(req: ForwardRequest): Promise<ForwardResult> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
      const account = this.pool.acquire(req.provider);
      if (!account) {
        throw httpError(503, 'all accounts exhausted (rate-limited or none configured)');
      }

      const proxy = this.rotator.current();
      const base = (account.baseUrl ?? CONFIG.upstreamBase).replace(/\/+$/, '');
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
        const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
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
        return this.toResult(upstream);
      }

      // 429 / quota / transient 5xx: park the token, rotate egress IP,
      // mint a fresh session id, then retry transparently.
      this.pool.markLimited(account.id);
      this.rotator.rotate();
      this.sessions.rotate();
      try {
        await upstream.body?.cancel();
      } catch {
        /* ignore */
      }
      lastError = new Error(`upstream ${upstream.status} on account ${account.id}`);
      await sleep(backoff(attempt));
    }

    throw httpError(502, `upstream unreachable after ${CONFIG.maxRetries + 1} attempts: ${String(lastError)}`);
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
