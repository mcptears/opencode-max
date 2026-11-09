import crypto from 'node:crypto';

/**
 * Stable Zen session ids (`ses_...`), keyed by account.
 *
 * Console routes a conversation consistently and reuses its prompt cache when
 * the same x-opencode-session is sent with every request. Go requires the
 * header. IDs are therefore stable per account, not rotated on rate limits:
 * minting a fresh identity to dodge a 429 would be circumventing the plan's
 * usage limits.
 */
export class SessionManager {
  private defaultId = SessionManager.fresh();
  private readonly byAccount = new Map<string, string>();

  static fresh(): string {
    return `ses_${crypto.randomUUID().replace(/-/g, '')}`;
  }

  /** Fallback id for keyless/anonymous forwards. */
  get id(): string {
    return this.defaultId;
  }

  /** Stable session id for an account, created lazily. */
  idFor(accountId: string): string {
    if (!accountId) return this.defaultId;
    const existing = this.byAccount.get(accountId);
    if (existing) return existing;
    const id = SessionManager.fresh();
    this.byAccount.set(accountId, id);
    return id;
  }

  /** Drop an account's session id (e.g. when the account is removed). */
  forget(accountId: string): void {
    this.byAccount.delete(accountId);
  }

  /** Mint a fresh fallback id. Retained for explicit/manual resets only. */
  rotate(): string {
    this.defaultId = SessionManager.fresh();
    return this.defaultId;
  }
}
