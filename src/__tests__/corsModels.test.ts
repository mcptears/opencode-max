import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type expressTypes from 'express';
import { corsV1, aggregateModels, buildRouter } from '../routes.js';
import { AccountPool } from '../accountPool.js';
import { SessionManager } from '../sessionManager.js';
import type { ProviderConfig } from '../providers.js';
import { saveSettings } from '../settings.js';

function fakeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let ended = false;
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    getHeader: (k: string) => headers[k.toLowerCase()],
    status: (c: number) => {
      statusCode = c;
      return res;
    },
    end: () => {
      ended = true;
      return res;
    },
  } as unknown as expressTypes.Response;
  return { res, headers, status: () => statusCode, ended: () => ended };
}

const providers: ProviderConfig[] = [
  { id: 'p1', name: 'P1', baseUrl: 'http://p1.invalid/v1', models: ['*'], enabled: true },
  { id: 'p2', name: 'P2', baseUrl: 'http://p2.invalid/v1', models: ['*'], enabled: true },
];

const stubRotator = {
  current: () => null,
  currentFamily: () => 4 as const,
  dispatcherFor: () => undefined,
} as never;

beforeEach(() => {
  saveSettings({ clientTokens: [] });
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: unknown) => {
      const u = String(url);
      // The test's own HTTP calls to the ephemeral server must go through.
      if (u.includes('127.0.0.1')) return realFetch(u, init as RequestInit);
      if (u.includes('p2.invalid')) throw new Error('connection refused');
      return new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm1' }, { id: 'm2' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('corsV1', () => {
  it('sets CORS headers and passes GET through', () => {
    const { res, headers } = fakeRes();
    let next = false;
    corsV1({ method: 'GET' } as expressTypes.Request, res, () => {
      next = true;
    });
    expect(next).toBe(true);
    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('answers preflights with 204 without calling next', () => {
    const { res, status, ended } = fakeRes();
    let next = false;
    corsV1({ method: 'OPTIONS' } as expressTypes.Request, res, () => {
      next = true;
    });
    expect(next).toBe(false);
    expect(status()).toBe(204);
    expect(ended()).toBe(true);
  });
});

describe('aggregateModels', () => {
  it('dedupes across providers and skips unreachable ones', async () => {
    const pool = new AccountPool([
      { id: 'a1', name: 'a1', provider: 'p1', apiKey: 'k', priority: 1 },
      { id: 'a2', name: 'a2', provider: 'p2', apiKey: 'k', priority: 1 },
    ]);
    const data = await aggregateModels(pool, stubRotator, () => providers);
    const ids = (data as { id: string }[]).map((m) => m.id).sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('releases the acquired account (no in-flight leak)', async () => {
    const pool = new AccountPool([{ id: 'a1', name: 'a1', provider: 'p1', apiKey: 'k', priority: 1 }]);
    await aggregateModels(pool, stubRotator, () => [providers[0]]);
    // With the default cap the slot must be free again for the next call.
    for (let i = 0; i < 6; i++) {
      await aggregateModels(pool, stubRotator, () => [providers[0]]);
    }
    expect(pool.status()[0].inflight).toBe(0);
  });
});

describe('/v1/models caching', () => {
  it('hits upstream at most once per TTL', async () => {
    const pool = new AccountPool([{ id: 'a1', name: 'a1', provider: 'p1', apiKey: 'k', priority: 1 }]);
    const app = express();
    app.use(buildRouter(pool, stubRotator, new SessionManager(), undefined, undefined, () => [providers[0]]));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const get = async () => (await fetch(`http://127.0.0.1:${port}/v1/models`)).json() as Promise<{ data: unknown[] }>;
      const first = await get();
      const second = await get();
      expect(first.data.length).toBe(2);
      expect(second.data.length).toBe(2);
      // Two HTTP calls, but the upstream /models fetch ran only once (cached).
      const upstreamCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
        String(url).includes('p1.invalid'),
      );
      expect(upstreamCalls.length).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
