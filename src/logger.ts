import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { getSettings } from './settings.js';

/**
 * Optional file logging with size-based rotation.
 *
 * When `logFile` is set, console output is mirrored to the file (with
 * timestamps). When the file exceeds `logMaxMb`, it is rotated:
 * file → file.1 → file.2 … keeping `logKeep` generations.
 * Logging failures never break the proxy.
 */

const original = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
};

let active = false;

function rotateIfNeeded(file: string, maxBytes: number, keep: number): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // doesn't exist yet
  }
  if (size < maxBytes) return;
  // Shift generations up: .(keep-1) → .keep, …, .1 → .2, file → .1
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
}

function mirror(file: string, maxBytes: number, keep: number, level: keyof typeof original, args: unknown[]): void {
  original[level].apply(console, args as []);
  try {
    rotateIfNeeded(file, maxBytes, keep);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${util.format(...args)}\n`);
  } catch {
    /* logging must never break the proxy */
  }
}

/** Start mirroring console output to the configured log file (no-op if unset). */
export function initFileLogger(): void {
  if (active) return;
  const s = getSettings();
  const file = s.logFile.trim();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(file, ''); // fail fast if not writable
  } catch {
    original.error(`file logging disabled: cannot write to ${file}`);
    return;
  }
  const maxBytes = Math.max(1, s.logMaxMb) * 1024 * 1024;
  const keep = Math.max(1, Math.floor(s.logKeep));
  console.log = (...args: unknown[]) => mirror(file, maxBytes, keep, 'log', args);
  console.error = (...args: unknown[]) => mirror(file, maxBytes, keep, 'error', args);
  console.warn = (...args: unknown[]) => mirror(file, maxBytes, keep, 'warn', args);
  console.debug = (...args: unknown[]) => mirror(file, maxBytes, keep, 'debug', args);
  active = true;
}

/** Re-read settings and restart file logging (used after dashboard saves). */
export function reinitFileLogger(): void {
  if (!active) {
    initFileLogger();
    return;
  }
  console.log = original.log;
  console.error = original.error;
  console.warn = original.warn;
  console.debug = original.debug;
  active = false;
  initFileLogger();
}
