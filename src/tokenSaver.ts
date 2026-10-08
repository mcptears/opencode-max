/**
 * RTK-style token saver: compresses bloated tool_result payloads before they
 * reach upstream. Agentic loops routinely stuff tens of thousands of chars of
 * diffs/logs into tool results; this collapses blank runs, dedupes repeated
 * lines, and middle-truncates whatever is still oversized — keeping the head
 * and tail where the signal usually lives. Only tool-result content is ever
 * touched; everything else passes through byte-identical.
 *
 * Returns the number of characters removed (for metrics).
 */
export function compressToolResults(body: unknown, maxChars: number): number {
  if (maxChars <= 0 || typeof body !== 'object' || body === null) return 0;
  let saved = 0;
  const messages = (body as { messages?: unknown }).messages;
  if (Array.isArray(messages)) {
    for (const m of messages) saved += compressMessage(m, maxChars);
  }
  return saved;
}

function compressMessage(msg: unknown, maxChars: number): number {
  if (typeof msg !== 'object' || msg === null) return 0;
  const m = msg as { role?: unknown; content?: unknown };
  let saved = 0;

  // OpenAI chat format: { role: 'tool', content: string | [...] }
  if (m.role === 'tool') {
    const { text, saved: s } = compressContent(m.content, maxChars);
    if (s > 0) {
      m.content = text;
      saved += s;
    }
    return saved;
  }

  // Anthropic messages format: content blocks with type 'tool_result'
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: unknown; content?: unknown };
      if (b.type === 'tool_result') {
        const { text, saved: s } = compressContent(b.content, maxChars);
        if (s > 0) {
          b.content = text;
          saved += s;
        }
      }
    }
  }
  return saved;
}

function compressContent(content: unknown, maxChars: number): { text: unknown; saved: number } {
  if (typeof content === 'string') {
    const r = compressText(content, maxChars);
    return { text: r.text, saved: r.saved };
  }
  if (Array.isArray(content)) {
    let saved = 0;
    const out = content.map((part) => {
      if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
        const p = part as { type: string; text?: unknown };
        if (typeof p.text === 'string') {
          const r = compressText(p.text, maxChars);
          saved += r.saved;
          return { ...p, text: r.text };
        }
      }
      return part;
    });
    return { text: out, saved };
  }
  return { text: content, saved: 0 };
}

export function compressText(text: string, maxChars: number): { text: string; saved: number } {
  if (text.length <= maxChars) return { text, saved: 0 };

  // 1. Collapse runs of blank lines.
  let t = text.replace(/\n{3,}/g, '\n\n');

  // 2. Collapse runs of identical consecutive lines (log spam).
  const lines = t.split('\n');
  const deduped: string[] = [];
  let dupes = 0;
  for (const line of lines) {
    if (deduped.length > 0 && deduped[deduped.length - 1] === line) {
      dupes += 1;
      continue;
    }
    if (dupes > 0) {
      deduped.push(`[… ${dupes} duplicate ${dupes === 1 ? 'line' : 'lines'} collapsed …]`);
      dupes = 0;
    }
    deduped.push(line);
  }
  if (dupes > 0) deduped.push(`[… ${dupes} duplicate ${dupes === 1 ? 'line' : 'lines'} collapsed …]`);
  t = deduped.join('\n');

  // 3. Middle-truncate whatever is still oversized, keeping head + tail.
  if (t.length > maxChars) {
    const keep = Math.floor(maxChars * 0.35);
    const head = t.slice(0, keep);
    const tail = t.slice(-keep);
    const removed = t.length - head.length - tail.length;
    t = `${head}\n[… trimmed ${removed} chars to save tokens …]\n${tail}`;
  }

  return { text: t, saved: Math.max(0, text.length - t.length) };
}
