import fs from 'node:fs';
import path from 'node:path';

export interface AccountConfig {
  id: string;
  name: string;
  /** Provider pool this account belongs to, e.g. "opencode-zen". */
  provider: string;
  apiKey: string;
  /** 1 = highest priority. Lower-priority accounts are used when higher ones cool down. */
  priority: number;
  /** ms the account stays parked after a 429/quota hit (default DEFAULT_COOLDOWN_MS). */
  cooldownPeriod?: number;
  /** Optional per-account upstream override (defaults to UPSTREAM_BASE). */
  baseUrl?: string;
  /** Optional per-account rolling 5h request budget (defaults to QUOTA_5H_LIMIT). */
  quotaLimit?: number;
}

export interface RuntimeConfig {
  port: number;
  upstreamBase: string;
  accountsFile: string;
  proxiesFile: string;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  defaultCooldownMs: number;
  requestTimeoutMs: number;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const CONFIG: RuntimeConfig = {
  port: num(process.env.PORT, 8080),
  upstreamBase: (process.env.UPSTREAM_BASE ?? 'https://opencode.ai/zen/v1').replace(/\/+$/, ''),
  accountsFile: process.env.ACCOUNTS_FILE ?? path.resolve('accounts.json'),
  proxiesFile: process.env.PROXIES_FILE ?? path.resolve('proxies.json'),
  maxRetries: num(process.env.MAX_RETRIES, 5),
  retryBaseMs: num(process.env.RETRY_BASE_MS, 1000),
  retryMaxMs: num(process.env.RETRY_MAX_MS, 30000),
  defaultCooldownMs: num(process.env.DEFAULT_COOLDOWN_MS, 300000),
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 120000),
};

/** Load and validate the accounts.json array (or { "accounts": [...] } wrapper). Sorted by priority. */
export function loadAccounts(filePath: string): AccountConfig[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`accounts file not found: ${filePath} (copy accounts.example.json to get started)`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { accounts?: unknown }).accounts) as AccountConfig[];
  if (!Array.isArray(list)) {
    throw new Error(`accounts file must contain an array: ${filePath}`);
  }
  if (list.length === 0) {
    console.warn('warning: account pool is empty — connect accounts from the dashboard to start proxying');
  }
  for (const a of list) {
    if (!a || typeof a.id !== 'string' || typeof a.apiKey !== 'string' ||
        typeof a.provider !== 'string' || typeof a.priority !== 'number') {
      throw new Error(`invalid account entry (id/provider/apiKey/priority required): ${JSON.stringify(a).slice(0, 120)}`);
    }
  }
  return [...list].sort((a, b) => a.priority - b.priority);
}

/** Proxy pool: PROXY_LIST env (comma-separated) wins, then proxies.json array. Empty = direct egress. */
export function loadProxies(filePath: string): string[] {
  const fromEnv = (process.env.PROXY_LIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { proxies?: unknown }).proxies) as unknown;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
}
