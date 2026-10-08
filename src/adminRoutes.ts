import { Router } from 'express';
import type express from 'express';
import type { AccountPool } from './accountPool.js';
import type { AccountConfig } from './config.js';
import type { IpRotator } from './ipRotator.js';
import type { Metrics } from './metrics.js';
import type { SessionManager } from './sessionManager.js';
import { getSettings, saveSettings, settingsFilePath } from './settings.js';
import { readAccounts, readProxies, writeAccounts, writeProxies } from './store.js';

export interface AdminContext {
  pool: AccountPool;
  rotator: IpRotator;
  sessions: SessionManager;
  metrics: Metrics;
}

function validateAccount(a: unknown): { ok: true; account: AccountConfig } | { ok: false; error: string } {
  if (!a || typeof a !== 'object') return { ok: false, error: 'body must be an object' };
  const r = a as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return { ok: false, error: 'id is required' };
  if (typeof r.provider !== 'string' || !r.provider.trim()) return { ok: false, error: 'provider is required' };
  if (typeof r.apiKey !== 'string' || !r.apiKey.trim()) return { ok: false, error: 'apiKey is required' };
  if (typeof r.priority !== 'number' || !Number.isFinite(r.priority)) return { ok: false, error: 'priority must be a number' };
  const account: AccountConfig = {
    id: r.id.trim(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.id.trim(),
    provider: (r.provider as string).trim(),
    apiKey: (r.apiKey as string).trim(),
    priority: r.priority as number,
    cooldownPeriod: typeof r.cooldownPeriod === 'number' && r.cooldownPeriod > 0 ? r.cooldownPeriod : undefined,
    baseUrl: typeof r.baseUrl === 'string' && (r.baseUrl as string).trim() ? (r.baseUrl as string).trim() : undefined,
  };
  return { ok: true, account };
}

/** Parse JSON bodies (index.ts uses express.raw, so req.body is a Buffer). */
function jsonBody(req: express.Request): unknown {
  const b = req.body as unknown;
  if (Buffer.isBuffer(b)) {
    if (b.length === 0) return {};
    try {
      return JSON.parse(b.toString('utf8'));
    } catch {
      return {};
    }
  }
  return b ?? {};
}

/** Guard mutating endpoints when ADMIN_TOKEN is configured. */
function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {  const token = getSettings().adminToken;
  if (!token) {
    next();
    return;
  }
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${token}`) {
    next();
    return;
  }
  res.status(401).json({ error: { message: 'admin token required', status: 401 } });
}

export function buildAdminRouter(ctx: AdminContext): Router {
  const router = Router();
  const { pool, rotator, metrics } = ctx;

  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) adminAuth(req, res, next);
    else next();
  };
  router.use(requireAuth);

  router.get('/api/status', (_req, res) => {
    const s = getSettings();
    res.json({
      ok: true,
      version: '1.0.0',
      port: s.port,
      upstream: s.upstreamBase,
      accounts: pool.status(),
      ip: rotator.status(),
      metrics: metrics.summary(),
    });
  });

  router.get('/api/metrics', (_req, res) => {
    res.json({ metrics: metrics.summary(), events: metrics.recentEvents(50) });
  });

  // ---- accounts ----
  router.get('/api/accounts', (_req, res) => {
    // Never leak keys: return status view only.
    res.json({ accounts: pool.status() });
  });

  router.post('/api/accounts', (req, res) => {
    const v = validateAccount(jsonBody(req));
    if (!v.ok) {
      res.status(400).json({ error: { message: v.error, status: 400 } });
      return;
    }
    const accounts = readAccounts();
    if (accounts.some((a) => a.id === v.account.id)) {
      res.status(409).json({ error: { message: `account '${v.account.id}' already exists`, status: 409 } });
      return;
    }
    accounts.push(v.account);
    writeAccounts(accounts);
    pool.replace(accounts);
    metrics.record('account_added', `account '${v.account.id}' added`);
    res.status(201).json({ ok: true });
  });

  router.put('/api/accounts/:id', (req, res) => {
    const v = validateAccount({ ...((jsonBody(req) ?? {}) as object), id: req.params.id });
    if (!v.ok) {
      res.status(400).json({ error: { message: v.error, status: 400 } });
      return;
    }
    const accounts = readAccounts();
    const i = accounts.findIndex((a) => a.id === req.params.id);
    if (i < 0) {
      res.status(404).json({ error: { message: 'account not found', status: 404 } });
      return;
    }
    accounts[i] = v.account;
    writeAccounts(accounts);
    pool.replace(accounts);
    metrics.record('account_added', `account '${v.account.id}' updated`);
    res.json({ ok: true });
  });

  router.delete('/api/accounts/:id', (req, res) => {
    const accounts = readAccounts();
    const next = accounts.filter((a) => a.id !== req.params.id);
    if (next.length === accounts.length) {
      res.status(404).json({ error: { message: 'account not found', status: 404 } });
      return;
    }
    writeAccounts(next);
    pool.replace(next);
    metrics.record('account_removed', `account '${req.params.id}' removed`);
    res.json({ ok: true });
  });

  /** Re-admit a key flagged invalid (use after fixing the key). */
  router.post('/api/accounts/:id/reset', (req, res) => {
    pool.clearInvalid(req.params.id);
    metrics.record('account_added', `account '${req.params.id}' reset after invalid-key flag`);
    res.json({ ok: true });
  });

  // ---- proxies ----
  router.get('/api/proxies', (_req, res) => {
    const st = rotator.status();
    res.json({ proxies: readProxies(), current: st.current, currentIndex: st.currentIndex, rotations: st.rotations, count: st.proxies });
  });

  router.post('/api/proxies', (req, res) => {
    const body = jsonBody(req) as { proxies?: unknown };
    const list = Array.isArray(body?.proxies) ? body.proxies : [];
    const clean = (list as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim());
    writeProxies(clean);
    rotator.setProxies(clean);
    metrics.record('proxy_added', `proxy pool replaced (${clean.length} entries)`);
    res.json({ ok: true, count: clean.length });
  });

  router.delete('/api/proxies', (req, res) => {
    const target = typeof req.query.proxy === 'string' ? req.query.proxy : '';
    const next = readProxies().filter((p) => p !== target);
    writeProxies(next);
    rotator.setProxies(next);
    metrics.record('proxy_removed', `proxy removed (${next.length} left)`);
    res.json({ ok: true, count: next.length });
  });

  router.post('/api/rotate', (_req, res) => {
    const current = rotator.rotate();
    metrics.rotated(current);
    res.json({ ok: true, ...rotator.status() });
  });

  // ---- settings ----
  router.get('/api/settings', (_req, res) => {
    const s = getSettings();
    res.json({
      settings: { ...s, adminToken: s.adminToken ? '••••••••' : '' },
      adminTokenSet: s.adminToken.length > 0,
      settingsFile: settingsFilePath(),
    });
  });

  router.post('/api/settings', (req, res) => {
    const body = jsonBody(req) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of ['upstreamBase', 'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs', 'requestTimeoutMs', 'adminToken'] as const) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    // Port changes are saved but only take effect after a restart.
    const portChanged = body.port !== undefined && Number(body.port) !== getSettings().port;
    if (body.port !== undefined) patch.port = body.port;
    const next = saveSettings(patch as Parameters<typeof saveSettings>[0]);
    metrics.record('settings', 'settings updated via dashboard');
    res.json({ ok: true, restartRequired: portChanged, settings: { ...next, adminToken: next.adminToken ? '••••••••' : '' } });
  });

  return router;
}
