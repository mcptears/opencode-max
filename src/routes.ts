import { Router } from 'express';
import type express from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import type { AccountPool } from './accountPool.js';
import type { IpRotator } from './ipRotator.js';
import type { Metrics } from './metrics.js';
import type { SessionManager } from './sessionManager.js';
import type { QuotaTracker } from './quota.js';
import { UpstreamClient } from './upstreamClient.js';
import type { Alerter } from './alerts.js';
import { matchProvider, defaultProvider, type ProviderConfig } from './providers.js';
import { getSettings } from './settings.js';

/**
 * Abort the upstream fetch if the client goes away mid-request.
 * NB: req 'close' fires when the request body is consumed (not on disconnect),
 * so we watch the RESPONSE: 'close' with !writableFinished means the client
 * disconnected before we finished sending.
 */
function abortOnClientClose(res: express.Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Pull the model id out of a JSON request body (chat completions, messages). */
export function extractModel(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined;
  try {
    const parsed = JSON.parse(bodyText) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Client token auth for /v1/*. When clientTokens is empty (default) the proxy
 * is open; otherwise clients must present one of the tokens as a Bearer token
 * or via the x-api-key header. OPTIONS preflights always pass through.
 */
export function clientTokenAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method === 'OPTIONS') return next();
  const tokens = getSettings().clientTokens;
  if (tokens.length === 0) return next();
  const auth = req.headers['authorization'];
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const apiKey = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string).trim() : '';
  if ((bearer && tokens.includes(bearer)) || (apiKey && tokens.includes(apiKey))) return next();
  res.status(401).json({ error: { message: 'missing or invalid client token', status: 401 } });
}

/**
 * Permissive CORS for /v1/* so browser-based clients can call the proxy
 * directly. The proxy binds to localhost, so this is same-trust as the user.
 * Preflights are answered here; clientTokenAuth lets OPTIONS through too.
 */
export function corsV1(req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/** Aggregate model lists from every enabled provider (deduplicated). */
export async function aggregateModels(
  pool: AccountPool,
  rotator: IpRotator,
  getProviders: () => ProviderConfig[],
): Promise<unknown[]> {
  const seen = new Set<string>();
  const data: unknown[] = [];
  for (const p of getProviders().filter((x) => x.enabled)) {
    // qwen-web has no upstream /models endpoint — synthesize from its config.
    if (p.protocol === 'qwen-web') {
      const qwen = p.qwen ?? { defaultModel: 'qwen3.7-plus' };
      const ids = [...Object.keys(qwen.modelMap ?? {}), qwen.defaultModel];
      for (const id of ids) {
        if (id && !seen.has(id)) {
          seen.add(id);
          data.push({ id, object: 'model', owned_by: 'qwen' });
        }
      }
      continue;
    }
    const account = pool.acquire(p.id);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetch(`${p.baseUrl}/models`, {
          headers: account?.apiKey ? { authorization: `Bearer ${account.apiKey}` } : {},
          dispatcher: rotator.dispatcherFor(rotator.current(), rotator.currentFamily()),
          signal: controller.signal,
        } as RequestInit & { dispatcher?: unknown });
        if (!r.ok) continue;
        const j = (await r.json()) as { data?: { id?: unknown }[] };
        for (const m of j.data ?? []) {
          const id = typeof m?.id === 'string' ? m.id : null;
          if (id && !seen.has(id)) {
            seen.add(id);
            data.push(m);
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* provider unreachable — skip it, don't fail the whole list */
    } finally {
      // acquire() bumps the in-flight count — always pair it with release().
      if (account) pool.release(account.id);
    }
  }
  return data;
}

/** Upstream /models is hit at most once per TTL (dashboard edits land within a minute). */
export const MODELS_CACHE_TTL_MS = 60_000;

export function buildRouter(
  pool: AccountPool,
  rotator: IpRotator,
  sessions: SessionManager,
  metrics?: Metrics,
  quota?: QuotaTracker,
  getProviders: () => ProviderConfig[] = () => [],
  alerter?: Alerter,
): Router {
  const router = Router();
  const upstream = new UpstreamClient(pool, rotator, sessions, metrics, quota, getProviders, alerter);

  router.use('/v1', corsV1);
  router.use('/v1', clientTokenAuth);

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      providers: getProviders().map((p) => ({ id: p.id, name: p.name, enabled: p.enabled })),
      ip: rotator.status(),
      accounts: pool.status().length,
    });
  });

  /** Pool status (keys are never exposed). */
  router.get('/v1/accounts', (_req, res) => {
    res.json({ accounts: pool.status(), ip: rotator.status() });
  });

  /** Manual egress rotation, e.g. curl -X POST localhost:8080/v1/rotate */
  router.post('/v1/rotate', (_req, res) => {
    const current = rotator.rotate();
    res.json({ ok: true, ...rotator.status() });
  });

  const proxy = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    try {
      const zenPath = req.path.replace(/^\/v1/, '') || '/';
      const qIndex = req.originalUrl.indexOf('?');
      const bodyText =
        Buffer.isBuffer(req.body) && req.body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD'
          ? (req.body as Buffer).toString('utf8')
          : undefined;

      const providers = getProviders();
      const provider = matchProvider(providers, extractModel(bodyText)) ?? defaultProvider(providers);
      if (!provider) throw httpError(503, 'no providers enabled — add one in the dashboard');

      const result = await upstream.forward({
        method: req.method,
        path: zenPath,
        query: qIndex >= 0 ? req.originalUrl.slice(qIndex) : '',
        headers: req.headers as Record<string, string | string[] | undefined>,
        bodyText,
        provider: provider.id,
        // Providers like a self-hosted qwen2api need no API key at all.
        allowAnonymous: true,
        signal: abortOnClientClose(res),
      });

      res.status(result.status);
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      if (result.body) {
        Readable.fromWeb(result.body as unknown as NodeWebStream).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  };

  /** Aggregated model list, cached briefly so every client poll doesn't fan out. */
  let modelsCache: { at: number; data: unknown[] } | null = null;
  router.get('/v1/models', async (_req, res, next) => {
    try {
      if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) {
        res.json({ object: 'list', data: modelsCache.data });
        return;
      }
      const data = await aggregateModels(pool, rotator, getProviders);
      modelsCache = { at: Date.now(), data };
      res.json({ object: 'list', data });
    } catch (err) {
      next(err);
    }
  });

  router.post('/v1/chat/completions', proxy);
  router.post('/v1/messages', proxy);
  // Catch-all for any other upstream paths.
  router.all(/^\/v1\/.*/, proxy);

  return router;
}
