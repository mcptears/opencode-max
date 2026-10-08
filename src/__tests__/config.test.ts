import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAccounts } from '../config.js';

describe('loadAccounts', () => {
  it('allows an empty pool so the dashboard Connect flow can onboard', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'om-cfg-')), 'accounts.json');
    fs.writeFileSync(f, JSON.stringify({ accounts: [] }));
    expect(loadAccounts(f)).toEqual([]);
  });

  it('rejects malformed entries', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'om-cfg-')), 'accounts.json');
    fs.writeFileSync(f, JSON.stringify({ accounts: [{ id: 'x' }] }));
    expect(() => loadAccounts(f)).toThrow();
  });
});
