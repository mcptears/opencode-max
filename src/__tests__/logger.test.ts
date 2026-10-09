import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initFileLogger, reinitFileLogger } from '../logger.js';
import { saveSettings } from '../settings.js';

let dir: string;
let logFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-logtest-'));
  logFile = path.join(dir, 'proxy.log');
  saveSettings({ logFile: '', logMaxMb: 10, logKeep: 3 });
});

afterEach(() => {
  saveSettings({ logFile: '' });
  reinitFileLogger(); // restores the original console methods
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('file logger', () => {
  it('is a no-op when logFile is empty', () => {
    const orig = console.log;
    initFileLogger();
    expect(console.log).toBe(orig);
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('mirrors console output to the file with a timestamp', () => {
    saveSettings({ logFile });
    initFileLogger();
    console.log('hello file');
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('hello file');
    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });

  it('rotates when the file exceeds the size limit', () => {
    saveSettings({ logFile, logMaxMb: 1, logKeep: 2 });
    // Pre-fill beyond 1MB so the next write triggers rotation.
    fs.writeFileSync(logFile, 'x'.repeat(1.2 * 1024 * 1024));
    initFileLogger();
    console.log('after rotation');
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.statSync(`${logFile}.1`).size).toBeGreaterThan(1024 * 1024);
    expect(fs.statSync(logFile).size).toBeLessThan(1024 * 1024);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('after rotation');
  });

  it('reinit picks up settings changes and restores console when cleared', () => {
    saveSettings({ logFile });
    reinitFileLogger();
    const mirrored = console.log;
    console.log('one');
    expect(fs.readFileSync(logFile, 'utf8')).toContain('one');

    saveSettings({ logFile: '' });
    reinitFileLogger();
    expect(console.log).not.toBe(mirrored);
    // No crash, no new file content from a different path.
    console.log('two');
    expect(fs.readFileSync(logFile, 'utf8')).not.toContain('two');
  });
});
