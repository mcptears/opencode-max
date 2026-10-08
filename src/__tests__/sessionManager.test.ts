import { describe, it, expect } from 'vitest';
import { SessionManager } from '../sessionManager.js';

describe('SessionManager', () => {
  it('issues ses_ ids and rotates to a fresh one', () => {
    const s = new SessionManager();
    expect(s.id).toMatch(/^ses_[0-9a-f]{32}$/);
    const before = s.id;
    const after = s.rotate();
    expect(after).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(after).not.toBe(before);
    expect(s.id).toBe(after);
  });
});
