import { describe, it, expect, beforeEach } from 'vitest';
import type express from 'express';
import { clientTokenAuth } from '../routes.js';
import { saveSettings } from '../settings.js';

function req(method: string, headers: Record<string, string> = {}): express.Request {
  return { method, headers } as unknown as express.Request;
}

function res(): { res: express.Response; statusCode: () => number; body: () => unknown } {
  let code = 0;
  let payload: unknown;
  const r = {
    status(c: number) {
      code = c;
      return r;
    },
    json(b: unknown) {
      payload = b;
      return r;
    },
  } as unknown as express.Response;
  return { res: r, statusCode: () => code, body: () => payload };
}

beforeEach(() => {
  saveSettings({ clientTokens: [] });
});

describe('client token auth', () => {
  it('passes everything through when no tokens are configured', () => {
    let next = false;
    clientTokenAuth(req('POST'), res().res, () => {
      next = true;
    });
    expect(next).toBe(true);
  });

  it('rejects missing credentials with 401 when tokens are configured', () => {
    saveSettings({ clientTokens: ['sekret'] });
    const r = res();
    let next = false;
    clientTokenAuth(req('POST'), r.res, () => {
      next = true;
    });
    expect(next).toBe(false);
    expect(r.statusCode()).toBe(401);
    expect(String(JSON.stringify(r.body()))).toContain('invalid client token');
  });

  it('rejects a wrong token with 401', () => {
    saveSettings({ clientTokens: ['sekret'] });
    const r = res();
    let next = false;
    clientTokenAuth(req('POST', { authorization: 'Bearer wrong' }), r.res, () => {
      next = true;
    });
    expect(next).toBe(false);
    expect(r.statusCode()).toBe(401);
  });

  it('accepts a correct Bearer token', () => {
    saveSettings({ clientTokens: ['sekret'] });
    let next = false;
    clientTokenAuth(req('POST', { authorization: 'Bearer sekret' }), res().res, () => {
      next = true;
    });
    expect(next).toBe(true);
  });

  it('accepts a correct x-api-key', () => {
    saveSettings({ clientTokens: ['sekret'] });
    let next = false;
    clientTokenAuth(req('POST', { 'x-api-key': 'sekret' }), res().res, () => {
      next = true;
    });
    expect(next).toBe(true);
  });

  it('accepts any of several configured tokens', () => {
    saveSettings({ clientTokens: ['one', 'two'] });
    let next = false;
    clientTokenAuth(req('POST', { 'x-api-key': 'two' }), res().res, () => {
      next = true;
    });
    expect(next).toBe(true);
  });

  it('lets OPTIONS preflights through even when tokens are configured', () => {
    saveSettings({ clientTokens: ['sekret'] });
    let next = false;
    clientTokenAuth(req('OPTIONS'), res().res, () => {
      next = true;
    });
    expect(next).toBe(true);
  });
});
