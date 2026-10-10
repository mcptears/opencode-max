import { Router } from 'express';
import type express from 'express';
import type { AccountPool } from './accountPool.js';
import type { AccountConfig } from './config.js';
import type { IpRotator } from './ipRotator.js';
import type { Metrics } from './metrics.js';
import type { SessionManager } from './sessionManager.js';
import { getSettings, saveSettings, settingsFilePath, parseModelFallbacks, parseModelTimeouts } from './settings.js';
import { reinitFileLogger } from './logger.js';
import { renderPrometheus } from './prometheus.js';
import { validateQwenCredential, qwenSignIn } from './qwenWeb.js';
import { readAccounts, readProxies, writeAccounts, writeProxies } from './store.js';
import { createHash } from 'node:crypto';
import { loadProviders as loadScraperProviders, saveProviders as saveScraperProviders, testProxy, type ProviderFormat } from './scraper.js';
import { loadProviders, saveProviders, QWEN_PRESET, type ProviderConfig } from './providers.js';
import type { ScraperJob } from './scraperJob.js';

export interface AdminContext {
  pool: AccountPool;
  rotator: IpRotator;
  sessions: SessionManager;
  metrics: Metrics;
  scraper: ScraperJob;
}

function validateAccount(a: unknown): { ok: true; account: AccountConfig } | { ok: false; error: string } {
  if (!a || typeof a !== 'object') return { ok: false, error: 'body must be an object' };
  const r = a as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return { ok: false, error: 'id is required' };
  if (typeof r.provider !== 'string' || !r.provider.trim()) return { ok: false, error: 'provider is required' };
  // Empty key is allowed: keyless providers (e.g. self-hosted qwen2api without API_TOKENS).
  if (typeof r.apiKey !== 'string') return { ok: false, error: 'apiKey must be a string' };
  if (typeof r.priority !== 'number' || !Number.isFinite(r.priority)) return { ok: false, error: 'priority must be a number' };
  const account: AccountConfig = {
    id: r.id.trim(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.id.trim(),
    provider: (r.provider as string).trim(),
    apiKey: (r.apiKey as string).trim(),
    priority: r.priority as number,
    cooldownPeriod: typeof r.cooldownPeriod === 'number' && r.cooldownPeriod > 0 ? r.cooldownPeriod : undefined,
    baseUrl: typeof r.baseUrl === 'string' && (r.baseUrl as string).trim() ? (r.baseUrl as string).trim() : undefined,
    quotaLimit:
      typeof r.quotaLimit === 'number' && Number.isFinite(r.quotaLimit) && r.quotaLimit > 0
        ? Math.floor(r.quotaLimit)
        : undefined,
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

  /** account id -> provider name, rebuilt per call so dashboard edits apply live. */
  const providerOf = (): ((id: string) => string) => {
    const map = new Map(pool.status().map((a) => [a.id, a.provider] as const));
    return (id: string) => map.get(id) ?? '';
  };

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
      quota5hLimit: s.quota5hLimit,
    });
  });

  router.get('/api/metrics', (_req, res) => {
    res.json({ metrics: metrics.summary(), events: metrics.recentEvents(50) });
  });

  /** Hourly traffic history for the dashboard chart. */
  router.get('/api/metrics/history', (req, res) => {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
    res.json({ hours, buckets: metrics.history(hours) });
  });

  /** Per-model usage: requests, errors, avg latency over the last N hours. */
  router.get('/api/metrics/models', (req, res) => {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
    res.json({ hours, models: metrics.modelStats(hours, providerOf()) });
  });

  /** Token usage (prompt/completion) reported by upstreams, per account and model. */
  router.get('/api/usage', (req, res) => {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
    res.json({ hours, ...metrics.usageStats(hours) });
  });

  /** Per-provider health: volume, success rate, latency, last error. */
  router.get('/api/metrics/providers', (req, res) => {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
    res.json({ hours, providers: metrics.providerHealth(hours, providerOf()) });
  });

  /** Prometheus exposition format for external monitoring (Grafana, …). */
  router.get('/metrics', (_req, res) => {
    res.type('text/plain; version=0.0.4').send(renderPrometheus(metrics, pool));
  });

  /** Recent proxied requests, newest first (dashboard inspector). */
  router.get('/api/requests', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json({ requests: metrics.recentRequests(limit, providerOf()) });
  });

  // ---- accounts ----
  router.get('/api/accounts', (_req, res) => {
    // Never leak keys: return status view only.
    res.json({ accounts: pool.status() });
  });

  /** Validate a Qwen web credential (token or cookie) without adding it. */
  router.post('/api/accounts/validate-qwen', async (req, res) => {
    const body = jsonBody(req) as { credential?: unknown; baseUrl?: unknown };
    const credential = typeof body.credential === 'string' ? body.credential.trim() : '';
    if (!credential) {
      res.status(400).json({ ok: false, error: 'credential is required' });
      return;
    }
    const base =
      typeof body.baseUrl === 'string' && body.baseUrl.trim()
        ? body.baseUrl.trim().replace(/\/+$/, '')
        : (loadProviders().find((p) => p.protocol === 'qwen-web')?.baseUrl ?? 'https://chat.qwen.ai');
    const r = await validateQwenCredential(base, credential);
    res.json(r);
  });

  /**
   * Sign in to Qwen with email + password and connect the account in one
   * step — no DevTools needed. The browser should SHA-256 the password
   * first (it never needs to send the plaintext); if it sends `password`
   * instead, the server hashes it before forwarding. The password is never
   * stored — only the Qwen session credential lands in the account pool.
   */
  router.post('/api/accounts/qwen-login', async (req, res) => {
    const body = jsonBody(req) as { email?: unknown; passwordHash?: unknown; password?: unknown; name?: unknown; priority?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    let passwordHash = typeof body.passwordHash === 'string' ? body.passwordHash.trim() : '';
    if (!passwordHash && typeof body.password === 'string' && body.password) {
      passwordHash = createHash('sha256').update(body.password).digest('hex');
    }
    if (!email || !email.includes('@')) {
      res.status(400).json({ ok: false, error: 'a valid email is required' });
      return;
    }
    if (!/^[0-9a-f]{64}$/i.test(passwordHash)) {
      res.status(400).json({ ok: false, error: 'password is required' });
      return;
    }
    // Make sure the native Qwen provider exists so the account has a home.
    const providers = loadProviders();
    let qwenProvider = providers.find((p) => p.protocol === 'qwen-web');
    if (!qwenProvider) {
      providers.push({ ...QWEN_PRESET });
      saveProviders(providers);
      qwenProvider = providers[providers.length - 1];
      metrics.record('settings', 'native qwen provider preset added (via Qwen sign-in)');
    }
    const login = await qwenSignIn(qwenProvider.baseUrl, email, passwordHash);
    if (!login.ok) {
      res.json(login);
      return;
    }
    const accounts = readAccounts();
    let n = 1;
    while (accounts.some((a) => a.id === `qwen-${n}`)) n++;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : email.split('@')[0];
    const priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? body.priority : n;
    const account: AccountConfig = { id: `qwen-${n}`, name, provider: qwenProvider.id, apiKey: login.credential, priority };
    accounts.push(account);
    writeAccounts(accounts);
    pool.replace(accounts);
    metrics.record('account_added', `qwen account '${account.id}' connected via sign-in`);
    res.status(201).json({ ok: true, id: account.id });
  });

  /** Check an API key against upstream without adding it (Connect flow).
   *  The models catalog is public, so validation sends a minimal 1-token
   *  chat ping: 401 with an auth-flavoured body means a bad key; anything
   *  else (200, 429, model errors) means the key itself is accepted. */
  router.post('/api/accounts/validate', async (req, res) => {
    const body = jsonBody(req) as { apiKey?: unknown; baseUrl?: unknown };
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey) {
      res.status(400).json({ ok: false, error: 'API key is required' });
      return;
    }
    const base =
      typeof body.baseUrl === 'string' && body.baseUrl
        ? body.baseUrl.replace(/\/+$/, '')
        : getSettings().upstreamBase;
    const authHeaders = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    const withTimeout = async (url: string, init: RequestInit): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      // Pick a real, non-free model for the ping.
      const modelsRes = await withTimeout(`${base}/models`, { headers: authHeaders });
      if (modelsRes.status === 401 || modelsRes.status === 403) {
        res.json({ ok: false, error: 'key rejected by upstream (401/403) — check the key' });
        return;
      }
      let model = 'big-pickle';
      try {
        const catalog = (await modelsRes.json()) as { data?: { id?: string }[] };
        const ids = (catalog.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
        model = ids.find((id) => !id.endsWith('-free')) ?? ids[0] ?? model;
      } catch {
        /* fall back to default probe model */
      }
      const ping = await withTimeout(`${base}/chat/completions`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      });
      if (ping.status === 401) {
        let probe = '';
        try {
          probe = await ping.text();
        } catch {
          /* ignore */
        }
        if (/invalid|unauthorized|api.?key|bad.?credentials|incorrect/i.test(probe) && !/quota|rate/i.test(probe)) {
          res.json({ ok: false, error: 'key rejected by upstream — check the key' });
          return;
        }
      }
      res.json({ ok: true });
    } catch {
      res.json({ ok: false, error: 'could not reach upstream — check your connection' });
    }
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
    // A Qwen account needs the native qwen provider to route anywhere.
    // Auto-add the preset if the user connected before adding the provider
    // (same guarantee the qwen-login endpoint already makes).
    if (v.account.provider === QWEN_PRESET.id && !loadProviders().some((p) => p.id === QWEN_PRESET.id)) {
      const providers = loadProviders();
      providers.push({ ...QWEN_PRESET });
      saveProviders(providers);
      metrics.record('settings', 'native qwen provider preset added (auto, on account connect)');
    }
    accounts.push(v.account);
    writeAccounts(accounts);
    pool.replace(accounts);
    metrics.record('account_added', `account '${v.account.id}' added`);
    res.status(201).json({ ok: true });
  });

  router.put('/api/accounts/:id', (req, res) => {
    const body = (jsonBody(req) ?? {}) as Record<string, unknown>;
    const accounts = readAccounts();
    const i = accounts.findIndex((a) => a.id === req.params.id);
    if (i < 0) {
      res.status(404).json({ error: { message: 'account not found', status: 404 } });
      return;
    }
    // Empty apiKey on edit = keep the existing key (keys are never sent to the UI).
    // Explicit clearApiKey: true converts a keyed account to keyless.
    if (body.clearApiKey === true) {
      body.apiKey = '';
    } else if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
      body.apiKey = accounts[i].apiKey;
    }
    const v = validateAccount({ ...body, id: req.params.id });
    if (!v.ok) {
      res.status(400).json({ error: { message: v.error, status: 400 } });
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

  // ---- providers (multi-upstream, 9router-style) ----
  router.get('/api/providers', (_req, res) => {
    res.json({ providers: loadProviders() });
  });

  function validateProviderInput(body: unknown): { ok: true; provider: ProviderConfig } | { ok: false; error: string } {
    const b = (body ?? {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim().replace(/\/+$/, '') : '';
    const models = Array.isArray(b.models)
      ? (b.models as unknown[]).filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
      : [];
    if (!id) return { ok: false, error: 'id is required' };
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) return { ok: false, error: 'id must be alphanumeric with dashes/underscores' };
    if (!baseUrl) return { ok: false, error: 'baseUrl is required' };
    try {
      new URL(baseUrl);
    } catch {
      return { ok: false, error: 'baseUrl is not a valid URL' };
    }
    const provider: ProviderConfig = { id, name: name || id, baseUrl, models: models.length > 0 ? models : ['*'], enabled: b.enabled !== false };
    if (b.protocol === 'qwen-web') {
      const q = (b.qwen ?? {}) as Record<string, unknown>;
      const modelMap: Record<string, string> = {};
      if (q.modelMap && typeof q.modelMap === 'object') {
        for (const [k, v] of Object.entries(q.modelMap as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim()) modelMap[k] = v.trim();
        }
      }
      provider.protocol = 'qwen-web';
      provider.qwen = {
        defaultModel: typeof q.defaultModel === 'string' && q.defaultModel.trim() ? q.defaultModel.trim() : 'qwen3.7-plus',
        ...(Object.keys(modelMap).length > 0 ? { modelMap } : {}),
      };
    }
    return { ok: true, provider };
  }

  router.post('/api/providers', (req, res) => {
    const v = validateProviderInput(jsonBody(req));
    if (!v.ok) {
      res.status(400).json({ error: { message: v.error, status: 400 } });
      return;
    }
    const providers = loadProviders();
    if (providers.some((p) => p.id === v.provider.id)) {
      res.status(409).json({ error: { message: `provider '${v.provider.id}' already exists`, status: 409 } });
      return;
    }
    providers.push(v.provider);
    saveProviders(providers);
    metrics.record('settings', `provider '${v.provider.id}' added`);
    res.status(201).json({ ok: true });
  });

  router.put('/api/providers/:id', (req, res) => {
    const v = validateProviderInput({ ...((jsonBody(req) ?? {}) as object), id: req.params.id });
    if (!v.ok) {
      res.status(400).json({ error: { message: v.error, status: 400 } });
      return;
    }
    const providers = loadProviders();
    const i = providers.findIndex((p) => p.id === req.params.id);
    if (i < 0) {
      res.status(404).json({ error: { message: 'provider not found', status: 404 } });
      return;
    }
    providers[i] = v.provider;
    saveProviders(providers);
    metrics.record('settings', `provider '${v.provider.id}' updated`);
    res.json({ ok: true });
  });

  router.delete('/api/providers/:id', (req, res) => {
    const providers = loadProviders();
    if (providers.length <= 1) {
      res.status(400).json({ error: { message: 'cannot delete the last provider', status: 400 } });
      return;
    }
    const next = providers.filter((p) => p.id !== req.params.id);
    if (next.length === providers.length) {
      res.status(404).json({ error: { message: 'provider not found', status: 404 } });
      return;
    }
    saveProviders(next);
    metrics.record('settings', `provider '${req.params.id}' removed`);
    res.json({ ok: true });
  });

  /** One-click preset: native Qwen web provider (built into opencode-max). */
  router.post('/api/providers/preset/qwen', (_req, res) => {
    const providers = loadProviders();
    const existing = providers.find((p) => p.id === QWEN_PRESET.id);
    if (existing) {
      // Upgrade path: replace a legacy self-hosted qwen2api entry (127.0.0.1:8765)
      // with the native provider. Accounts keep working (same provider id).
      if (!existing.baseUrl.includes('8765')) {
        res.status(409).json({ error: { message: 'qwen provider already exists', status: 409 } });
        return;
      }
      const i = providers.indexOf(existing);
      providers[i] = { ...QWEN_PRESET };
      saveProviders(providers);
      metrics.record('settings', 'qwen provider upgraded to native qwen-web');
      res.json({ ok: true, upgraded: true, provider: QWEN_PRESET });
      return;
    }
    providers.push({ ...QWEN_PRESET });
    saveProviders(providers);
    metrics.record('settings', 'native qwen provider preset added');
    res.status(201).json({ ok: true, provider: QWEN_PRESET });
  });

  /** Test a provider's /models endpoint (no keys leaked). */
  router.post('/api/providers/:id/test', async (req, res) => {
    const p = loadProviders().find((x) => x.id === req.params.id);
    if (!p) {
      res.status(404).json({ error: { message: 'provider not found', status: 404 } });
      return;
    }
    try {
      const account = pool.acquire(p.id);
      // qwen-web has no /models endpoint — test the first account's credential instead.
      if (p.protocol === 'qwen-web') {
        if (account) pool.release(account.id);
        if (!account?.apiKey) {
          res.json({ ok: false, error: 'no Qwen account connected — use Connect Qwen account' });
          return;
        }
        const v = await validateQwenCredential(p.baseUrl, account.apiKey);
        res.json(v.ok ? { ok: true, models: Object.keys(p.qwen?.modelMap ?? {}).length + 1 } : { ok: false, error: v.error });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetch(`${p.baseUrl}/models`, {
          headers: account?.apiKey ? { authorization: `Bearer ${account.apiKey}` } : {},
          dispatcher: rotator.dispatcherFor(rotator.current(), rotator.currentFamily()),
          signal: controller.signal,
        } as RequestInit & { dispatcher?: unknown });
        if (!r.ok) {
          res.json({ ok: false, error: `HTTP ${r.status}` });
          return;
        }
        const j = (await r.json()) as { data?: unknown[] };
        res.json({ ok: true, models: Array.isArray(j.data) ? j.data.length : 0 });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      res.json({ ok: false, error: String(e).slice(0, 160) });
    }
  });

  // ---- proxies ----
  router.get('/api/proxies', (_req, res) => {
    const st = rotator.status();
    res.json({ proxies: readProxies(), current: st.current, currentIndex: st.currentIndex, rotations: st.rotations, count: st.proxies, health: st.health });
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
    rotator.rotate();
    metrics.rotated(rotator.egressLabel());
    res.json({ ok: true, ...rotator.status() });
  });

  /** Test a list of proxies without adding them. */
  router.post('/api/proxies/test', async (req, res) => {
    const body = jsonBody(req) as { proxies?: unknown };
    const list = Array.isArray(body.proxies) ? body.proxies.filter((p): p is string => typeof p === 'string') : [];
    const results = await Promise.all(
      list.slice(0, 50).map(async (proxy) => ({ proxy, ok: await testProxy(proxy) })),
    );
    res.json({ results });
  });

  // ---- proxy scraper ----
  router.get('/api/scraper/providers', (_req, res) => {
    res.json({ providers: loadScraperProviders() });
  });

  router.get('/api/scraper/status', (_req, res) => {
    res.json(ctx.scraper.status());
  });

  router.post('/api/scraper/run', (_req, res) => {
    if (!ctx.scraper.start(false)) {
      res.status(409).json({ error: { message: 'a scrape is already running', status: 409 } });
      return;
    }
    res.status(202).json({ ok: true, started: true });
  });

  router.post('/api/scraper/providers', (req, res) => {
    const body = jsonBody(req) as { name?: unknown; url?: unknown; format?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const format: ProviderFormat =
      body.format === 'geonode' || body.format === 'spys' || body.format === 'fpl' || body.format === 'proxynova'
        ? body.format
        : 'text';
    if (!name || !url) {
      res.status(400).json({ error: { message: 'name and url are required', status: 400 } });
      return;
    }
    try {
      new URL(url);
    } catch {
      res.status(400).json({ error: { message: 'url is not valid', status: 400 } });
      return;
    }
    const providers = loadScraperProviders();
    const id = `custom-${Date.now().toString(36)}`;
    providers.push({ id, name, url, format, enabled: true });
    saveScraperProviders(providers);
    metrics.record('proxy_added', `scraper provider '${name}' added`);
    res.status(201).json({ ok: true, id });
  });

  router.put('/api/scraper/providers/:id', (req, res) => {
    const body = jsonBody(req) as { name?: unknown; url?: unknown; format?: unknown; enabled?: unknown };
    const providers = loadScraperProviders();
    const p = providers.find((x) => x.id === req.params.id);
    if (!p) {
      res.status(404).json({ error: { message: 'provider not found', status: 404 } });
      return;
    }
    if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();
    if (typeof body.url === 'string' && body.url.trim()) {
      try {
        new URL(body.url.trim());
      } catch {
        res.status(400).json({ error: { message: 'url is not valid', status: 400 } });
        return;
      }
      p.url = body.url.trim();
    }
    if (['text', 'geonode', 'spys', 'fpl', 'proxynova'].includes(body.format as string)) p.format = body.format as ProviderFormat;
    if (typeof body.enabled === 'boolean') p.enabled = body.enabled;
    saveScraperProviders(providers);
    res.json({ ok: true });
  });

  router.delete('/api/scraper/providers/:id', (req, res) => {
    const providers = loadScraperProviders();
    const next = providers.filter((x) => x.id !== req.params.id);
    if (next.length === providers.length) {
      res.status(404).json({ error: { message: 'provider not found', status: 404 } });
      return;
    }
    saveScraperProviders(next);
    metrics.record('proxy_removed', `scraper provider '${req.params.id}' removed`);
    res.json({ ok: true });
  });

  // ---- settings ----
  router.get('/api/settings', (_req, res) => {
    const s = getSettings();
    res.json({
      settings: { ...s, adminToken: s.adminToken ? '••••••••' : '', alertWebhookUrl: s.alertWebhookUrl ? '••••••••' : '', clientTokens: [] },
      adminTokenSet: s.adminToken.length > 0,
      clientTokensCount: s.clientTokens.length,
      alertWebhookSet: s.alertWebhookUrl.length > 0,
      settingsFile: settingsFilePath(),
    });
  });

  router.post('/api/settings', (req, res) => {
    const body = jsonBody(req) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of ['upstreamBase', 'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs', 'requestTimeoutMs', 'adminToken', 'quota5hLimit'] as const) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (typeof body.proxyHealthCheck === 'boolean') patch.proxyHealthCheck = body.proxyHealthCheck;
    if (body.proxyHealthIntervalMs !== undefined) patch.proxyHealthIntervalMs = body.proxyHealthIntervalMs;
    if (typeof body.tokenSaver === 'boolean') patch.tokenSaver = body.tokenSaver;
    if (body.tokenSaverMaxChars !== undefined) patch.tokenSaverMaxChars = body.tokenSaverMaxChars;
    if (body.egressFamily === 'auto' || body.egressFamily === '4' || body.egressFamily === '6') {
      patch.egressFamily = body.egressFamily;
    }
    if (typeof body.autoScrape === 'boolean') patch.autoScrape = body.autoScrape;
    if (body.autoScrapeIntervalHours !== undefined) patch.autoScrapeIntervalHours = body.autoScrapeIntervalHours;
    if (body.routingStrategy === 'priority' || body.routingStrategy === 'latency') patch.routingStrategy = body.routingStrategy;
    if (body.queueMaxWaitMs !== undefined) patch.queueMaxWaitMs = body.queueMaxWaitMs;
    if (typeof body.alertWebhookUrl === 'string' && body.alertWebhookUrl) patch.alertWebhookUrl = body.alertWebhookUrl;
    if (body.accountConcurrency !== undefined) patch.accountConcurrency = body.accountConcurrency;
    if (body.proxyAutoDropFails !== undefined) patch.proxyAutoDropFails = body.proxyAutoDropFails;
    if (body.modelFallbacks !== undefined) {
      const clean = parseModelFallbacks(JSON.stringify(body.modelFallbacks));
      patch.modelFallbacks = clean;
    }
    if (body.modelTimeouts !== undefined) {
      patch.modelTimeouts = parseModelTimeouts(JSON.stringify(body.modelTimeouts));
    }
    if (typeof body.logFile === 'string') patch.logFile = body.logFile.trim();
    if (body.logMaxMb !== undefined) patch.logMaxMb = body.logMaxMb;
    if (body.logKeep !== undefined) patch.logKeep = body.logKeep;
    if (body.shutdownDrainMs !== undefined) patch.shutdownDrainMs = body.shutdownDrainMs;
    if (body.errorSpikeThreshold !== undefined) patch.errorSpikeThreshold = body.errorSpikeThreshold;
    if (body.errorSpikeWindowMin !== undefined) patch.errorSpikeWindowMin = body.errorSpikeWindowMin;
    if (body.errorSpikeMinRequests !== undefined) patch.errorSpikeMinRequests = body.errorSpikeMinRequests;
    // Client tokens: dashboard sends a comma-separated string only when replacing;
    // clearClientTokens wipes them. Never redacted into the page, count only.
    if (typeof body.clearClientTokens === 'boolean' && body.clearClientTokens) {
      patch.clientTokens = [];
    } else if (typeof body.clientTokens === 'string' && body.clientTokens.trim()) {
      patch.clientTokens = body.clientTokens.split(',').map((t) => t.trim()).filter(Boolean);
    }
    // Port changes are saved but only take effect after a restart.
    const portChanged = body.port !== undefined && Number(body.port) !== getSettings().port;
    if (body.port !== undefined) patch.port = body.port;
    const next = saveSettings(patch as Parameters<typeof saveSettings>[0]);
    // Apply health-check toggling and egress family live.
    rotator.stopHealthChecks();
    if (next.proxyHealthCheck) rotator.startHealthChecks(next.proxyHealthIntervalMs);
    rotator.configureEgress({ familyMode: next.egressFamily });
    reinitFileLogger(); // pick up logFile / rotation changes without a restart
    metrics.record('settings', 'settings updated via dashboard');
    res.json({ ok: true, restartRequired: portChanged, settings: { ...next, adminToken: next.adminToken ? '••••••••' : '', clientTokens: [] }, clientTokensCount: next.clientTokens.length });
  });

  // ---- backup / restore ----
  // Export everything (accounts, providers, scraper providers, settings).
  // Contains API keys — require auth even for GET.
  router.get('/api/backup', (req, res) => {
    adminAuth(req, res, () => {
      res.setHeader(
        'content-disposition',
        `attachment; filename="opencode-max-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      );
      let accounts: AccountConfig[] = [];
      try {
        accounts = readAccounts();
      } catch {
        /* no accounts file yet — export empty */
      }
      res.json({
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts,
        providers: loadProviders(),
        scraperProviders: loadScraperProviders(),
        settings: getSettings(),
      });
    });
  });

  /** Restore a backup file. Only the sections present in the payload are replaced. */
  router.post('/api/backup/restore', (req, res) => {
    const body = jsonBody(req) as Record<string, unknown>;
    const bad = (msg: string): void => {
      res.status(400).json({ error: { message: msg, status: 400 } });
    };

    let accounts: AccountConfig[] | null = null;
    if (body.accounts !== undefined) {
      if (!Array.isArray(body.accounts)) return bad('accounts must be an array');
      accounts = [];
      for (const a of body.accounts) {
        const v = validateAccount(a);
        if (!v.ok) return bad(`invalid account: ${v.error}`);
        accounts.push(v.account);
      }
    }

    let providers: ProviderConfig[] | null = null;
    if (body.providers !== undefined) {
      if (!Array.isArray(body.providers)) return bad('providers must be an array');
      providers = [];
      for (const p of body.providers) {
        const v = validateProviderInput(p);
        if (!v.ok) return bad(`invalid provider: ${v.error}`);
        providers.push(v.provider);
      }
    }

    let scraperProviders: { id: string; name: string; url: string; format: ProviderFormat; enabled: boolean }[] | null = null;
    if (body.scraperProviders !== undefined) {
      if (!Array.isArray(body.scraperProviders)) return bad('scraperProviders must be an array');
      scraperProviders = [];
      for (const p of body.scraperProviders as Record<string, unknown>[]) {
        if (!p || typeof p.id !== 'string' || typeof p.url !== 'string') return bad('invalid scraper provider entry');
        try {
          new URL(p.url);
        } catch {
          return bad(`invalid scraper provider url: ${p.url}`);
        }
        scraperProviders.push({
          id: p.id,
          name: typeof p.name === 'string' ? p.name : p.id,
          url: p.url,
          format: p.format === 'geonode' || p.format === 'spys' || p.format === 'fpl' || p.format === 'proxynova' ? p.format : 'text',
          enabled: p.enabled !== false,
        });
      }
    }

    // All sections validated — apply.
    if (accounts) {
      writeAccounts(accounts);
      pool.replace(accounts);
    }
    if (providers) saveProviders(providers);
    if (scraperProviders) saveScraperProviders(scraperProviders);
    if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
      saveSettings(body.settings as Parameters<typeof saveSettings>[0]);
    }
    metrics.record('settings', 'configuration restored from backup');
    res.json({ ok: true });
  });

  return router;
}
