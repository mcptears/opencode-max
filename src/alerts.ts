/**
 * Webhook alerts for operational events (dead keys, pool exhaustion).
 * Fire-and-forget: failures never break the proxy. Per-event cooldown
 * (default 15 min) prevents alert spam.
 *
 * Any JSON webhook works. For Telegram, use the Bot API URL with the chat id
 * as a query param — it accepts {"text"} in the body:
 *   https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>
 */
export class Alerter {
  private readonly lastSent = new Map<string, number>();

  constructor(private readonly getUrl: () => string) {}

  async send(event: string, detail: string, cooldownMs = 15 * 60_000): Promise<void> {
    const url = this.getUrl();
    if (!url) return;
    const now = Date.now();
    if (now - (this.lastSent.get(event) ?? 0) < cooldownMs) return;
    this.lastSent.set(event, now);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event,
          text: `[opencode-max] ${detail}`,
          detail,
          time: new Date(now).toISOString(),
          source: 'opencode-max',
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      /* alerts must never break the proxy */
    }
  }
}
