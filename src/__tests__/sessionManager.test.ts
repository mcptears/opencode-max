import { describe, it, expect } from 'vitest';
import { SessionManager } from '../sessionManager.js';

describe('SessionManager', () => {
  it('issues stable ses_ ids per account', () => {
    const s = new SessionManager();
    const first = s.idFor('acct-a');
    expect(first).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(s.idFor('acct-a')).toBe(first);
    expect(s.idFor('acct-b')).not.toBe(first);
    s.forget('acct-a');
    expect(s.idFor('acct-a')).not.toBe(first);
  });

  it('keeps a fallback id and can rotate it explicitly', () => {
    const s = new SessionManager();
    expect(s.id).toMatch(/^ses_[0-9a-f]{32}$/);
    const before = s.id;
    const after = s.rotate();
    expect(after).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(after).not.toBe(before);
    expect(s.id).toBe(after);
  });
});
