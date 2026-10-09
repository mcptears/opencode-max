import type express from 'express';
import { getSettings } from './settings.js';

/**
 * Graceful shutdown helpers.
 *
 * On SIGTERM/SIGINT we stop accepting new connections, wait for in-flight
 * requests to finish (up to a drain timeout), destroy idle keep-alive
 * sockets, and only then exit — so proxied requests aren't cut mid-stream.
 */

/** Wait until isIdle() is true or timeoutMs elapses. True = drained cleanly. */
export async function waitForDrain(isIdle: () => boolean, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (isIdle()) return true;
    if (Date.now() >= deadline) return isIdle();
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

/** Express middleware that counts in-flight requests; safe against double-counting. */
export function inflightTracker(): { middleware: express.RequestHandler; inFlight: () => number } {
  let count = 0;
  const middleware: express.RequestHandler = (_req, res, next) => {
    count++;
    let done = false;
    const leave = (): void => {
      if (!done) {
        done = true;
        count--;
      }
    };
    res.on('finish', leave);
    res.on('close', leave);
    next();
  };
  return { middleware, inFlight: () => count };
}

/** Drain timeout for graceful shutdown (dashboard setting, default 30s). */
export function drainTimeoutMs(): number {
  const v = getSettings().shutdownDrainMs;
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 30_000;
}
