import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { globMatch } from './providers.js';

export interface Settings {
  port: number;
  upstreamBase: string;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  defaultCooldownMs: number;
  requestTimeoutMs: number;
  /** Optional bearer token guarding mutating admin endpoints. Empty = open on loopback. */
  adminToken: string;
  /** Periodic proxy health probing (skips dead proxies in rotation). */
  proxyHealthCheck: boolean;
  proxyHealthIntervalMs: number;
  /** Direct-egress IP family: 'auto' alternates v4/v6 on dual-stack hosts. */
  egressFamily: 'auto' | '4' | '6';
  /** Rolling 5h request budget per account before the pool steers away. */
  quota5hLimit: number;
  /** Compress bloated tool_result payloads before forwarding (saves tokens). */
  tokenSaver: boolean;
  tokenSaverMaxChars: number;
  /** Periodically re-scrape free proxy providers to keep the pool fresh. */
  autoScrape: boolean;
  autoScrapeIntervalHours: number;
  /** Account selection: 'priority' (P1 first) or 'latency' (fastest known first). */
  routingStrategy: 'priority' | 'latency';
  /** Max time a request waits for a cooling account instead of failing fast. */
  queueMaxWaitMs: number;
  /** Optional webhook POSTed on dead keys / pool exhaustion (Telegram-compatible). */
  alertWebhookUrl: string;
  /** Max parallel in-flight requests per account (0 = unlimited). */
  accountConcurrency: number;
  /** Consecutive real-request failures before a proxy is auto-dropped (0 = off). */
  proxyAutoDropFails: number;
  /** Model fallback chains: when a model is exhausted everywhere, try these in order. */
  modelFallbacks: Record<string, string[]>;
  /** Error-spike alerts: webhook when the recent error rate exceeds this (0-1). */
  errorSpikeThreshold: number;
  /** Window (minutes) over which the error rate is measured. */
  errorSpikeWindowMin: number;
  /** Minimum requests in the window before a spike can trigger. */
  errorSpikeMinRequests: number;
  /** Client API tokens for /v1/* (empty = no auth required). */
  clientTokens: string[];
  /** Per-model upstream timeouts in ms: exact name or glob pattern → timeout. */
  modelTimeouts: Record<string, number>;
}

const SETTINGS_FILE = process.env.SETTINGS_FILE ?? path.resolve('settings.json');

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && (n as number) >= 0 ? (n as number) : fallback;
};

const bool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

function fromEnv(): Settings {
  return {
    port: num(process.env.PORT, 8080),
    upstreamBase: (process.env.UPSTREAM_BASE ?? 'https://opencode.ai/zen/v1').replace(/\/+$/, ''),
    maxRetries: num(process.env.MAX_RETRIES, 5),
    retryBaseMs: num(process.env.RETRY_BASE_MS, 1000),
    retryMaxMs: num(process.env.RETRY_MAX_MS, 30000),
    defaultCooldownMs: num(process.env.DEFAULT_COOLDOWN_MS, 300000),
    requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 120000),
    adminToken: process.env.ADMIN_TOKEN ?? '',
    proxyHealthCheck: bool(process.env.PROXY_HEALTH_CHECK, true),
    proxyHealthIntervalMs: num(process.env.PROXY_HEALTH_INTERVAL_MS, 60000),
    egressFamily: parseEgressFamily(process.env.EGRESS_FAMILY),
    quota5hLimit: num(process.env.QUOTA_5H_LIMIT, 200),
    tokenSaver: bool(process.env.TOKEN_SAVER, true),
    tokenSaverMaxChars: num(process.env.TOKEN_SAVER_MAX_CHARS, 20000),
    autoScrape: bool(process.env.AUTO_SCRAPE, false),
    autoScrapeIntervalHours: num(process.env.AUTO_SCRAPE_INTERVAL_HOURS, 6),
    routingStrategy: parseRoutingStrategy(process.env.ROUTING_STRATEGY),
    queueMaxWaitMs: num(process.env.QUEUE_MAX_WAIT_MS, 30000),
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
    accountConcurrency: num(process.env.ACCOUNT_CONCURRENCY, 4),
    proxyAutoDropFails: num(process.env.PROXY_AUTO_DROP_FAILS, 5),
    modelFallbacks: parseModelFallbacks(process.env.MODEL_FALLBACKS),
    errorSpikeThreshold: num(process.env.ERROR_SPIKE_THRESHOLD, 0.5),
    errorSpikeWindowMin: num(process.env.ERROR_SPIKE_WINDOW_MIN, 10),
    errorSpikeMinRequests: num(process.env.ERROR_SPIKE_MIN_REQUESTS, 10),
    clientTokens: (process.env.CLIENT_TOKENS ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    modelTimeouts: parseModelTimeouts(process.env.MODEL_TIMEOUTS),
  };
}

function parseRoutingStrategy(v: string | undefined): 'priority' | 'latency' {
  return (v ?? '').toLowerCase() === 'latency' ? 'latency' : 'priority';
}

/** Validate/normalize the MODEL_FALLBACKS JSON map (model -> [fallback models]). */
export function parseModelFallbacks(v: string | undefined): Record<string, string[]> {
  if (!v) return {};
  try {
    const raw = JSON.parse(v) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, list] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof k === 'string' && Array.isArray(list)) {
        const models = list.filter((m): m is string => typeof m === 'string' && m.length > 0);
        if (models.length > 0) out[k] = models;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function parseModelTimeouts(v: string | undefined): Record<string, number> {
  if (!v) return {};
  try {
    const raw = JSON.parse(v) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, ms] of Object.entries(raw as Record<string, unknown>)) {
      const n = typeof ms === 'number' ? ms : Number(ms);
      if (typeof k === 'string' && k.length > 0 && Number.isFinite(n) && n >= 1000) {
        out[k] = Math.floor(n);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve the upstream timeout for a model: exact name match wins, then the
 * first glob pattern that matches, then the global default.
 */
export function resolveModelTimeout(
  timeouts: Record<string, number>,
  model: string | undefined,
  defaultMs: number,
): number {
  if (model && timeouts[model] !== undefined) return timeouts[model];
  if (model) {
    for (const [pattern, ms] of Object.entries(timeouts)) {
      if (pattern.includes('*') && globMatch(pattern, model)) return ms;
    }
  }
  return defaultMs;
}

function parseEgressFamily(v: string | undefined): 'auto' | '4' | '6' {
  const s = (v ?? 'auto').toLowerCase();
  if (['4', 'v4', 'ipv4'].includes(s)) return '4';
  if (['6', 'v6', 'ipv6'].includes(s)) return '6';
  return 'auto';
}

let current: Settings = (() => {
  const base = fromEnv();
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
      return {
        port: num(raw.port, base.port),
        upstreamBase: typeof raw.upstreamBase === 'string' && raw.upstreamBase ? raw.upstreamBase.replace(/\/+$/, '') : base.upstreamBase,
        maxRetries: num(raw.maxRetries, base.maxRetries),
        retryBaseMs: num(raw.retryBaseMs, base.retryBaseMs),
        retryMaxMs: num(raw.retryMaxMs, base.retryMaxMs),
        defaultCooldownMs: num(raw.defaultCooldownMs, base.defaultCooldownMs),
        requestTimeoutMs: num(raw.requestTimeoutMs, base.requestTimeoutMs),
        adminToken: typeof raw.adminToken === 'string' ? raw.adminToken : base.adminToken,
        proxyHealthCheck: typeof raw.proxyHealthCheck === 'boolean' ? raw.proxyHealthCheck : base.proxyHealthCheck,
        proxyHealthIntervalMs: num(raw.proxyHealthIntervalMs, base.proxyHealthIntervalMs),
        egressFamily:
          raw.egressFamily === '4' || raw.egressFamily === '6' || raw.egressFamily === 'auto'
            ? raw.egressFamily
            : base.egressFamily,
        quota5hLimit: num(raw.quota5hLimit, base.quota5hLimit),
        tokenSaver: typeof raw.tokenSaver === 'boolean' ? raw.tokenSaver : base.tokenSaver,
        tokenSaverMaxChars: num(raw.tokenSaverMaxChars, base.tokenSaverMaxChars),
        autoScrape: typeof raw.autoScrape === 'boolean' ? raw.autoScrape : base.autoScrape,
        autoScrapeIntervalHours: num(raw.autoScrapeIntervalHours, base.autoScrapeIntervalHours),
        routingStrategy: raw.routingStrategy === 'latency' ? 'latency' : base.routingStrategy,
        queueMaxWaitMs: num(raw.queueMaxWaitMs, base.queueMaxWaitMs),
        alertWebhookUrl: typeof raw.alertWebhookUrl === 'string' ? raw.alertWebhookUrl : base.alertWebhookUrl,
        accountConcurrency: num(raw.accountConcurrency, base.accountConcurrency),
        proxyAutoDropFails: num(raw.proxyAutoDropFails, base.proxyAutoDropFails),
        modelFallbacks:
          raw.modelFallbacks && typeof raw.modelFallbacks === 'object' && !Array.isArray(raw.modelFallbacks)
            ? (raw.modelFallbacks as Record<string, string[]>)
            : base.modelFallbacks,
        errorSpikeThreshold: num(raw.errorSpikeThreshold, base.errorSpikeThreshold),
        errorSpikeWindowMin: num(raw.errorSpikeWindowMin, base.errorSpikeWindowMin),
        errorSpikeMinRequests: num(raw.errorSpikeMinRequests, base.errorSpikeMinRequests),
        clientTokens: Array.isArray(raw.clientTokens)
          ? raw.clientTokens.filter((t): t is string => typeof t === 'string' && t.length > 0)
          : base.clientTokens,
        modelTimeouts:
          raw.modelTimeouts && typeof raw.modelTimeouts === 'object'
            ? parseModelTimeouts(JSON.stringify(raw.modelTimeouts))
            : base.modelTimeouts,
      };
    }
  } catch {
    /* corrupted file -> fall back to env */
  }
  return base;
})();

export function getSettings(): Settings {
  return { ...current };
}

/** Persist a partial settings patch to settings.json and apply it live. */
export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = {
    port: patch.port !== undefined ? num(patch.port, current.port) : current.port,
    upstreamBase:
      typeof patch.upstreamBase === 'string' && patch.upstreamBase
        ? patch.upstreamBase.replace(/\/+$/, '')
        : current.upstreamBase,
    maxRetries: patch.maxRetries !== undefined ? num(patch.maxRetries, current.maxRetries) : current.maxRetries,
    retryBaseMs: patch.retryBaseMs !== undefined ? num(patch.retryBaseMs, current.retryBaseMs) : current.retryBaseMs,
    retryMaxMs: patch.retryMaxMs !== undefined ? num(patch.retryMaxMs, current.retryMaxMs) : current.retryMaxMs,
    defaultCooldownMs:
      patch.defaultCooldownMs !== undefined ? num(patch.defaultCooldownMs, current.defaultCooldownMs) : current.defaultCooldownMs,
    requestTimeoutMs:
      patch.requestTimeoutMs !== undefined ? num(patch.requestTimeoutMs, current.requestTimeoutMs) : current.requestTimeoutMs,
    adminToken: typeof patch.adminToken === 'string' ? patch.adminToken : current.adminToken,
    proxyHealthCheck: typeof patch.proxyHealthCheck === 'boolean' ? patch.proxyHealthCheck : current.proxyHealthCheck,
    proxyHealthIntervalMs:
      patch.proxyHealthIntervalMs !== undefined ? num(patch.proxyHealthIntervalMs, current.proxyHealthIntervalMs) : current.proxyHealthIntervalMs,
    egressFamily:
      patch.egressFamily === '4' || patch.egressFamily === '6' || patch.egressFamily === 'auto'
        ? patch.egressFamily
        : current.egressFamily,
    quota5hLimit:
      patch.quota5hLimit !== undefined ? num(patch.quota5hLimit, current.quota5hLimit) : current.quota5hLimit,
    tokenSaver: typeof patch.tokenSaver === 'boolean' ? patch.tokenSaver : current.tokenSaver,
    tokenSaverMaxChars:
      patch.tokenSaverMaxChars !== undefined ? num(patch.tokenSaverMaxChars, current.tokenSaverMaxChars) : current.tokenSaverMaxChars,
    autoScrape: typeof patch.autoScrape === 'boolean' ? patch.autoScrape : current.autoScrape,
    autoScrapeIntervalHours:
      patch.autoScrapeIntervalHours !== undefined
        ? num(patch.autoScrapeIntervalHours, current.autoScrapeIntervalHours)
        : current.autoScrapeIntervalHours,
    routingStrategy: patch.routingStrategy === 'latency' || patch.routingStrategy === 'priority' ? patch.routingStrategy : current.routingStrategy,
    queueMaxWaitMs:
      patch.queueMaxWaitMs !== undefined ? num(patch.queueMaxWaitMs, current.queueMaxWaitMs) : current.queueMaxWaitMs,
    alertWebhookUrl: typeof patch.alertWebhookUrl === 'string' ? patch.alertWebhookUrl : current.alertWebhookUrl,
    accountConcurrency:
      patch.accountConcurrency !== undefined ? num(patch.accountConcurrency, current.accountConcurrency) : current.accountConcurrency,
    proxyAutoDropFails:
      patch.proxyAutoDropFails !== undefined ? num(patch.proxyAutoDropFails, current.proxyAutoDropFails) : current.proxyAutoDropFails,
    modelFallbacks:
      patch.modelFallbacks && typeof patch.modelFallbacks === 'object' && !Array.isArray(patch.modelFallbacks)
        ? patch.modelFallbacks
        : current.modelFallbacks,
    errorSpikeThreshold:
      patch.errorSpikeThreshold !== undefined
        ? Math.min(1, Math.max(0, num(patch.errorSpikeThreshold, current.errorSpikeThreshold)))
        : current.errorSpikeThreshold,
    errorSpikeWindowMin:
      patch.errorSpikeWindowMin !== undefined ? num(patch.errorSpikeWindowMin, current.errorSpikeWindowMin) : current.errorSpikeWindowMin,
    errorSpikeMinRequests:
      patch.errorSpikeMinRequests !== undefined ? num(patch.errorSpikeMinRequests, current.errorSpikeMinRequests) : current.errorSpikeMinRequests,
    clientTokens:
      Array.isArray(patch.clientTokens)
        ? patch.clientTokens.filter((t): t is string => typeof t === 'string' && t.length > 0)
        : current.clientTokens,
    modelTimeouts:
      patch.modelTimeouts && typeof patch.modelTimeouts === 'object'
        ? parseModelTimeouts(JSON.stringify(patch.modelTimeouts))
        : current.modelTimeouts,
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  current = next;
  // Keep the legacy CONFIG snapshot in sync for anything still reading it.
  CONFIG.port = next.port;
  CONFIG.upstreamBase = next.upstreamBase;
  CONFIG.maxRetries = next.maxRetries;
  CONFIG.retryBaseMs = next.retryBaseMs;
  CONFIG.retryMaxMs = next.retryMaxMs;
  CONFIG.defaultCooldownMs = next.defaultCooldownMs;
  CONFIG.requestTimeoutMs = next.requestTimeoutMs;
  return getSettings();
}

export function settingsFilePath(): string {
  return SETTINGS_FILE;
}
