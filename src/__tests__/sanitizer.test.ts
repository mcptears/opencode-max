import { describe, it, expect } from 'vitest';
import { sanitizeHeaders, sanitizePayload } from '../sanitizer.js';

describe('sanitizeHeaders', () => {
  it('strips identity, telemetry and hop-by-hop headers', () => {
    const out = sanitizeHeaders({
      authorization: 'Bearer old',
      cookie: 'sess=1',
      'x-real-ip': '1.2.3.4',
      'x-forwarded-for': '5.6.7.8',
      'x-opencode-session': 'ses_old',
      connection: 'keep-alive',
      'content-type': 'application/json',
      'x-custom': 'keep-me',
    });
    expect(out).toEqual({ 'content-type': 'application/json', 'x-custom': 'keep-me' });
  });

  it('is case-insensitive', () => {
    expect(sanitizeHeaders({ 'X-Real-IP': '1.2.3.4', ok: '1' })).toEqual({ ok: '1' });
  });
});

describe('sanitizePayload', () => {
  it('drops telemetry fields and swaps stale session GUIDs', () => {
    const fresh = 'ses_fresh';
    const out = sanitizePayload(
      {
        model: 'x',
        telemetry: { a: 1 },
        clientTelemetry: [1],
        session_id: '123e4567-e89b-12d3-a456-426614174000',
        nested: { sessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        keep: 'yes',
      },
      fresh,
    );
    expect(out).toEqual({
      model: 'x',
      session_id: fresh,
      nested: { sessionId: fresh },
      keep: 'yes',
    });
  });

  it('leaves non-GUID session values alone', () => {
    const out = sanitizePayload({ session_id: 'my-local-name' }, 'ses_fresh');
    expect(out.session_id).toBe('my-local-name');
  });
});
