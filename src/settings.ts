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
}

const SETTINGS_FILE = process.env.SETTINGS_FILE ?? path.resolve('settings.json');

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && (n as number) >= 0 ? (n as number) : fallback;
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
  };
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
