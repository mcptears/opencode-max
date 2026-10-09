import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type express from 'express';
import { waitForDrain, inflightTracker, drainTimeoutMs } from '../shutdown.js';

afterEach(() => {
  delete process.env.SHUTDOWN_DRAIN_MS;
});

describe('waitForDrain', () => {
  it('returns true immediately when already idle', async () => {
    await expect(waitForDrain(() => true, 1000)).resolves.toBe(true);
  });

  it('waits until the predicate flips', async () => {
    let idle = false;
    setTimeout(() => {
      idle = true;
    }, 30);
    await expect(waitForDrain(() => idle, 2000, 5)).resolves.toBe(true);
  });

  it('returns false after the timeout when never idle', async () => {
    const start = Date.now();
    await expect(waitForDrain(() => false, 80, 5)).resolves.toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('inflightTracker', () => {
  function fakeRes(): express.Response {
    return new EventEmitter() as unknown as express.Response;
  }

  it('counts in-flight requests and releases on finish', () => {
    const t = inflightTracker();
    const res = fakeRes();
    t.middleware({} as express.Request, res, () => undefined);
    expect(t.inFlight()).toBe(1);
    (res as unknown as EventEmitter).emit('finish');
    expect(t.inFlight()).toBe(0);
  });

  it('does not double-decrement when both finish and close fire', () => {
    const t = inflightTracker();
    const res = fakeRes();
    t.middleware({} as express.Request, res, () => undefined);
    const ee = res as unknown as EventEmitter;
    ee.emit('finish');
    ee.emit('close');
    expect(t.inFlight()).toBe(0);
  });

  it('releases on close without finish (aborted client)', () => {
    const t = inflightTracker();
    const res = fakeRes();
    t.middleware({} as express.Request, res, () => undefined);
    (res as unknown as EventEmitter).emit('close');
    expect(t.inFlight()).toBe(0);
  });
});

describe('drainTimeoutMs', () => {
  it('defaults to 30s', () => {
    expect(drainTimeoutMs()).toBe(30_000);
  });

  it('honours the env override', () => {
    process.env.SHUTDOWN_DRAIN_MS = '5000';
    expect(drainTimeoutMs()).toBe(5000);
  });

  it('falls back on garbage', () => {
    process.env.SHUTDOWN_DRAIN_MS = 'nope';
    expect(drainTimeoutMs()).toBe(30_000);
  });
});
