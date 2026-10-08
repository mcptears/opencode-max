import fs from 'node:fs';
import { CONFIG, loadAccounts, loadProxies, type AccountConfig } from './config.js';

/**
 * File-backed persistence for the dashboard-editable stores.
 * accounts.json is always written with mode 0600 (it holds API keys).
 */
export function readAccounts(): AccountConfig[] {
  return loadAccounts(CONFIG.accountsFile);
}

export function writeAccounts(accounts: AccountConfig[]): void {
  const sorted = [...accounts].sort((a, b) => a.priority - b.priority);
  fs.writeFileSync(CONFIG.accountsFile, JSON.stringify({ accounts: sorted }, null, 2) + '\n', { mode: 0o600 });
}

export function readProxies(): string[] {
  return loadProxies(CONFIG.proxiesFile);
}

export function writeProxies(proxies: string[]): void {
  const clean = proxies.map((p) => p.trim()).filter(Boolean);
  fs.writeFileSync(CONFIG.proxiesFile, JSON.stringify({ proxies: clean }, null, 2) + '\n', { mode: 0o600 });
}
