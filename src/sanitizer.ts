/**
 * Payload / header stripping for upstream requests.
 *
 * What we strip and why:
 * - Hop-by-hop headers (connection, transfer-encoding, ...) — never valid upstream.
 * - `cookie` / `set-cookie` — session pinning we don't want to leak.
 * - Spoofed IP hints (x-real-ip, x-forwarded-for, true-client-ip, cf-connecting-ip):
 *   OpenCode's edge overwrites/rejects these, so forwarding them is at best noise.
 * - Stale `authorization` — we attach the pool token ourselves.
 * - `x-session-id` / `x-opencode-session` — we manage session ids centrally and
 *   rotate them on 429 (see sessionManager).
 * - Telemetry blobs (`telemetry`, `clientTelemetry`) in JSON payloads.
 * - Persistent `session_id` GUIDs inside JSON payloads are replaced with a fresh
 *   session id on every retry cycle.
 */

/** Headers never forwarded upstream. */
const STRIP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'cookie', 'set-cookie',
  'authorization',
  'content-length',
  'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'true-client-ip', 'cf-connecting-ip',
  'x-session-id', 'x-opencode-session',
]);

const TELEMETRY_FIELDS = new Set(['telemetry', '__telemetry', 'clientTelemetry']);

export function sanitizeHeaders(input: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (STRIP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function isGuidLike(s: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
    /^ses_[0-9a-f]{32}$/i.test(s)
  );
}

/** Deep-clone a JSON payload, dropping telemetry and swapping stale session GUIDs. */
export function sanitizePayload<T>(body: T, freshSessionId: string): T {
  if (body === null || typeof body !== 'object') return body;
  if (Array.isArray(body)) {
    return body.map((v) => sanitizePayload(v, freshSessionId)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (TELEMETRY_FIELDS.has(k)) continue;
    if ((k === 'session_id' || k === 'sessionId') && typeof v === 'string' && isGuidLike(v)) {
      out[k] = freshSessionId;
      continue;
    }
    out[k] = sanitizePayload(v, freshSessionId);
  }
  return out as T;
}
