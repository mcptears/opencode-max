import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

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
  };
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
