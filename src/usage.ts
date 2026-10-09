/** Extract `usage` token counts from an upstream response body, SSE-aware.
 *
 * Non-streaming responses carry usage in the JSON body; streaming (SSE)
 * responses carry it in a final `data:` chunk (OpenAI sends it when the
 * client requests stream_options.include_usage). The transform passes all
 * bytes through untouched and reports the last usage object seen when the
 * stream ends.
 */

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/** Cap on how much body text we buffer while sniffing for usage. */
const MAX_SNIFF_BYTES = 2 * 1024 * 1024;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function usageFrom(obj: unknown): TokenUsage | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const u = (obj as { usage?: unknown }).usage;
  if (!u || typeof u !== 'object') return undefined;
  const prompt = num((u as Record<string, unknown>).prompt_tokens);
  const completion = num((u as Record<string, unknown>).completion_tokens);
  const totalRaw = num((u as Record<string, unknown>).total_tokens);
  if (prompt === 0 && completion === 0 && totalRaw === 0) return undefined;
  return { prompt, completion, total: totalRaw || prompt + completion };
}

/** Best-effort usage extraction from a complete response body (JSON or SSE text). */
export function extractUsageFromText(text: string): TokenUsage | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Fast path: a plain JSON body.
  if (trimmed.startsWith('{')) {
    try {
      const found = usageFrom(JSON.parse(trimmed));
      if (found) return found;
    } catch {
      /* fall through to SSE scan */
    }
  }
  // SSE scan: keep the LAST usage object seen (final chunk is authoritative).
  let last: TokenUsage | undefined;
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const found = usageFrom(JSON.parse(payload));
      if (found) last = found;
    } catch {
      /* not JSON — skip */
    }
  }
  return last;
}

/**
 * Wrap an upstream body stream, passing bytes through unchanged and calling
 * onUsage once with the extracted token counts when the stream completes.
 */
export function trackUsage(
  body: ReadableStream<Uint8Array> | null,
  onUsage: (usage: TokenUsage) => void,
): ReadableStream<Uint8Array> | null {
  if (!body) return body;
  const decoder = new TextDecoder();
  let buffered = '';
  let truncated = false;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!truncated) {
        buffered += decoder.decode(chunk, { stream: true });
        if (buffered.length > MAX_SNIFF_BYTES) {
          truncated = true;
          buffered = ''; // give up sniffing; keep passing bytes through
        }
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (truncated) return;
      buffered += decoder.decode();
      const usage = extractUsageFromText(buffered);
      if (usage) {
        try {
          onUsage(usage);
        } catch {
          /* usage logging must never break the response */
        }
      }
    },
  });
  return body.pipeThrough(transform);
}
