import { setTimeout as sleep } from 'node:timers/promises';
import type { AccountPool } from './accountPool.js';
import type { IpRotator } from './ipRotator.js';
import type { Metrics } from './metrics.js';
import { sanitizeHeaders, sanitizePayload } from './sanitizer.js';
import { getSettings } from './settings.js';
import type { SessionManager } from './sessionManager.js';

/** Thrown when one provider can't serve the request; forward() fails over to the next. */
export class ProviderExhaustedError extends Error {}

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
  /**
   * When true and the provider has no accounts configured at all, forward
   * without an Authorization header instead of 503ing (e.g. a self-hosted
   * qwen2api with no API_TOKENS set).
   */
  allowAnonymous?: boolean;
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

import type { QuotaTracker } from './quota.js';
import { compressToolResults } from './tokenSaver.js';
import type { AccountConfig } from './config.js';
import { globMatch, type ProviderConfig } from './providers.js';

/**
 * Forwards requests to the configured upstream provider (OpenCode Zen by
 * default, or any OpenAI-compatible provider such as a self-hosted qwen2api)
 * with the combined rotation strategy: attach a pool token -> strip
 * identity/telemetry -> on 429 park the token, rotate the egress IP, mint a
 * fresh session id, and retry with backoff.
 */
export class UpstreamClient {
  constructor(
    private readonly pool: AccountPool,
    private readonly rotator: IpRotator,
    private readonly sessions: SessionManager,
    private readonly metrics?: Metrics,
    private readonly quota?: QuotaTracker,
    /** Live provider registry (dashboard edits apply without restart). */
    private readonly getProviders: () => ProviderConfig[] = () => [],
  ) {}

  /** account.baseUrl > provider.baseUrl > global upstreamBase */
  resolveBaseUrl(account: AccountConfig): string {
    if (account.baseUrl) return account.baseUrl.replace(/\/+$/, '');
    const provider = this.getProviders().find((p) => p.id === account.provider);
    if (provider?.baseUrl) return provider.baseUrl.replace(/\/+$/, '');
    return getSettings().upstreamBase.replace(/\/+$/, '');
  }

  /**
   * Forward with cross-provider failover: if the primary provider's accounts
   * are all exhausted (or its upstream is down), try the next eligible
   * provider before giving up. Fallback candidates must be able to serve the
   * model — their patterns match it, or they're a catch-all.
   */
  async forward(req: ForwardRequest): Promise<ForwardResult> {
    let model: string | undefined;
    if (req.bodyText) {
      try {
        const parsed = JSON.parse(req.bodyText) as { model?: unknown };
        if (typeof parsed.model === 'string') model = parsed.model;
      } catch {
        /* ignore */
      }
    }
    const chain = this.providerChain(req.provider, model);
    let lastError: unknown = null;
    for (let i = 0; i < chain.length; i++) {
      try {
        return await this.forwardToProvider(req, chain[i], model);
      } catch (e) {
        if (!(e instanceof ProviderExhaustedError)) throw e;
        lastError = e;
        if (i + 1 < chain.length) this.metrics?.failover(chain[i], chain[i + 1]);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw httpError(502, `all providers exhausted: ${detail}`);
  }

  /** Primary first, then other enabled providers eligible for this model. */
  private providerChain(primary: string | undefined, model: string | undefined): string[] {
    const enabled = this.getProviders().filter((p) => p.enabled);
    const chain: string[] = [];
    if (primary) chain.push(primary);
    for (const p of enabled) {
      if (chain.includes(p.id)) continue;
      if (!model || p.models.includes('*') || p.models.some((m) => globMatch(m, model))) {
        chain.push(p.id);
      }
    }
    return chain.length > 0 ? chain : [primary ?? 'default'];
  }

  private async forwardToProvider(req: ForwardRequest, providerId: string, model: string | undefined): Promise<ForwardResult> {
    let lastError: unknown = null;
    const maxRetries = getSettings().maxRetries;
    const startedAt = Date.now();
    let lastAccountId = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const realAccount = this.pool.acquire(providerId);
      // Keyless providers (no accounts configured) forward anonymously.
      const account: AccountConfig | null =
        realAccount ??
        (req.allowAnonymous && this.pool.count(providerId) === 0
          ? { id: `${providerId}:anonymous`, name: 'anonymous', provider: providerId, apiKey: '', priority: 1 }
          : null);
      if (!account) {
        const msg = this.pool.allInvalid(providerId)
          ? `all API keys are flagged invalid on '${providerId}' — fix them in the dashboard and reset`
          : `all accounts exhausted on '${providerId}' (rate-limited or none configured)`;
        this.metrics?.logRequest(lastAccountId || 'none', 503, Date.now() - startedAt, model);
        throw new ProviderExhaustedError(msg);
      }
      lastAccountId = account.id;
      this.metrics?.hit(account.id);

      const proxy = this.rotator.current();
      const base = this.resolveBaseUrl(account);
      const url = `${base}${req.path}${req.query}`;

      const headers = sanitizeHeaders(req.headers);
      if (account.apiKey) headers['authorization'] = `Bearer ${account.apiKey}`;
      headers['x-opencode-session'] = this.sessions.id;
      headers['accept'] = headers['accept'] ?? 'text/event-stream';

      let body: string | undefined;
      if (req.bodyText && req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          const parsed = sanitizePayload(JSON.parse(req.bodyText), this.sessions.id);
          const s = getSettings();
          if (s.tokenSaver) {
            const savedChars = compressToolResults(parsed, s.tokenSaverMaxChars);
            if (savedChars > 0) this.metrics?.addTokensSaved(Math.round(savedChars / 4));
          }
          body = JSON.stringify(parsed);
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
            dispatcher: this.rotator.dispatcherFor(proxy, this.rotator.currentFamily()),
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

      // Count the attempt against the account's quota: it reached upstream.
      // (Anonymous forwards have no account to count against.)
      if (account.apiKey) this.quota?.record(account.id);

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
          if (looksInvalid && account.apiKey) {
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
        this.metrics?.logRequest(account.id, upstream.status, Date.now() - startedAt, model);
        return this.toResult(upstream);
      }

      // 429 / quota / transient 5xx: park the token, rotate egress IP,
      // mint a fresh session id, then retry transparently.
      this.pool.markLimited(account.id);
      this.rotator.rotate();
      this.sessions.rotate();
      this.metrics?.limited(account.id);
      this.metrics?.rotated(this.rotator.egressLabel());
      this.metrics?.retried();
      try {
        await upstream.body?.cancel();
      } catch {
        /* ignore */
      }
      lastError = new Error(`upstream ${upstream.status} on account ${account.id}`);
      await sleep(backoff(attempt));
    }

    this.metrics?.logRequest(lastAccountId || 'none', 502, Date.now() - startedAt, model);
    throw new ProviderExhaustedError(`'${providerId}' unreachable after ${maxRetries + 1} attempts: ${String(lastError)}`);
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
