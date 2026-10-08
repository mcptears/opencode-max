import crypto from 'node:crypto';

/**
 * Per-client Zen session ids (`ses_...`).
 * Community proxies for the Zen free tier attach a session id to requests and
 * rotate it whenever a 429 arrives, so a fresh identity is presented on retry.
 */
export class SessionManager {
  private currentId = SessionManager.fresh();

  static fresh(): string {
    return `ses_${crypto.randomUUID().replace(/-/g, '')}`;
  }

  get id(): string {
    return this.currentId;
  }

  rotate(): string {
    this.currentId = SessionManager.fresh();
    return this.currentId;
  }
}
