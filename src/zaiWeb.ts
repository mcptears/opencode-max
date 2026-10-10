/**
 * Native Z.ai (chat.z.ai) web-chat provider — Z.ai runs *inside* opencode-max,
 * no separate proxy deployment needed.
 *
 * Protocol (chat.z.ai private web API, reverse-engineered):
 *   Auth: the user signs in at chat.z.ai in their own browser (solving the
 *         Aliyun captcha manually once), then copies the JWT from DevTools ->
 *         Application -> Local Storage -> "token". opencode-max never sees a
 *         password. Validate with GET /api/v1/auths/ (Bearer token).
 *         The JWT payload carries {id, email}; the id signs every request.
 *   Chat turn: POST /api/v2/chat/completions?<signed query>
 *         Headers: Authorization: Bearer <token>, X-Signature, X-FE-Version.
 *         The signature is an HMAC chain: bucket = floor(ts_ms / 300000),
 *         w_key = HMAC_SHA256(salt_key, bucket),
 *         sig = HMAC_SHA256(w_key, "{sorted k,v}|{prompt_b64}|{timestamp}").
 *         salt_key falls back to a baked-in constant when the homepage scrape
 *         misses; fe_version is scraped from the homepage the same way.
 *         Body: {model, chat_id, messages, signature_prompt, stream,
 *         features: {enable_thinking, web_search, ...}}.
 *         Response is SSE: data: {"data":{"delta_content":"..."}} ...
 *         data: {"data":{"phase":"done"}} / [DONE].
 *         Thinking streams wrapped in <details>...</details> tags — split
 *         into reasoning_content, the rest is content.
 *
 * Caveat: private, undocumented endpoints — any upstream change can break this.
 */

export class ZaiWebError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ZaiWebError';
    this.status = status;
  }
}

import { createHmac, randomUUID } from 'node:crypto';

export interface FetchOpts {
  timeoutMs?: number;
  /** undici dispatcher for proxy rotation (optional). */
  dispatcher?: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Baked-in fallback when the homepage scrape misses (matches public clients). */
export const ZAI_SALT_KEY_FALLBACK = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
export const ZAI_FE_VERSION_FALLBACK = 'prod-fe-1.0.185';

async function zaiFetch(baseUrl: string, path: string, init: RequestInit, opts: FetchOpts): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
      ...init,
      signal: ctrl.signal,
      dispatcher: opts.dispatcher,
    } as RequestInit & { dispatcher?: unknown });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function baseHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: 'https://chat.z.ai',
    referer: 'https://chat.z.ai/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
}

function authHeaders(token: string): Record<string, string> {
  return { ...baseHeaders(), authorization: `Bearer ${token}` };
}

/** Decode the JWT payload (no signature verification — we just need id/email). */
export function decodeZaiToken(token: string): { id: string; email: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { id?: unknown; email?: unknown };
    const id = typeof payload.id === 'string' ? payload.id : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (!id) return null;
    return { id, email };
  } catch {
    return null;
  }
}

/**
 * Lightweight credential check: GET /api/v1/auths/ with the Bearer token.
 * Returns the decoded identity on success.
 */
export async function validateZaiCredential(
  baseUrl: string,
  token: string,
  opts: FetchOpts = {},
): Promise<{ ok: true; id: string; email: string } | { ok: false; error: string }> {
  let r: Response;
  try {
    r = await zaiFetch(baseUrl, '/api/v1/auths/', { headers: authHeaders(token) }, opts);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, error: 'token rejected — sign in at chat.z.ai again and paste a fresh token' };
  }
  if (!r.ok) {
    return { ok: false, error: `token validation failed (${r.status})` };
  }
  const id = decodeZaiToken(token);
  if (!id) return { ok: false, error: 'token is not a valid Z.ai session token' };
  return { ok: true, id: id.id, email: id.email };
}

/** Scrape salt_key / fe_version from the homepage; fall back to constants. */
export async function scrapeZaiConfig(
  baseUrl: string,
  opts: FetchOpts = {},
): Promise<{ saltKey: string; feVersion: string }> {
  try {
    const r = await zaiFetch(baseUrl, '/', { headers: baseHeaders() }, { ...opts, timeoutMs: 15_000 });
    const html = await r.text();
    const m = html.match(/prod-fe-\d+\.\d+\.\d+/);
    return { saltKey: ZAI_SALT_KEY_FALLBACK, feVersion: m ? m[0] : ZAI_FE_VERSION_FALLBACK };
  } catch {
    return { saltKey: ZAI_SALT_KEY_FALLBACK, feVersion: ZAI_FE_VERSION_FALLBACK };
  }
}

export interface ZaiSignature {
  signature: string;
  query: string;
  timestamp: string;
  requestId: string;
}

function hmacSha256Hex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Build the X-Signature header value and the signed query string for a chat
 * turn. `prompt` is the last user message (signature_prompt).
 */
export function signZaiRequest(prompt: string, token: string, userId: string, saltKey: string): ZaiSignature {
  const timestamp = String(Date.now());
  const requestId = randomUUID();
  const bucket = Math.floor(Number(timestamp) / 300000);
  const wKey = hmacSha256Hex(saltKey, String(bucket));
  const payloadDict: Record<string, string> = { timestamp, requestId, user_id: userId };
  const sortedPayload = Object.keys(payloadDict)
    .sort()
    .map((k) => `${k},${payloadDict[k]}`)
    .join(',');
  const promptB64 = Buffer.from(prompt.trim(), 'utf8').toString('base64');
  const dataToSign = `${sortedPayload}|${promptB64}|${timestamp}`;
  const signature = hmacSha256Hex(wKey, dataToSign);
  const browserInfo: Record<string, string> = {
    version: '0.0.1',
    platform: 'web',
    token,
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    language: 'en-US',
    screen_resolution: '1920x1080',
    viewport_size: '1920x1080',
    timezone: 'Europe/Paris',
    timezone_offset: '-60',
  };
  const params = new URLSearchParams({ ...payloadDict, ...browserInfo });
  return { signature, query: `${params.toString()}&signature_timestamp=${timestamp}`, timestamp, requestId };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

export interface ZaiDelta {
  kind: 'think' | 'answer';
  text: string;
}

/**
 * Split accumulated Z.ai stream text into thinking vs answer. Thinking is
 * wrapped in <details ...>...</details>; strip the tags and any "> " quote
 * prefixes the way the web client renders them.
 */
export function splitZaiThinking(raw: string): { thinking: string; answer: string } {
  const open = raw.indexOf('<details');
  if (open < 0) return { thinking: '', answer: raw };
  const tagEnd = raw.indexOf('>', open);
  if (tagEnd < 0) return { thinking: '', answer: raw };
  const afterTag = raw.slice(tagEnd + 1);
  const close = afterTag.indexOf('</details>');
  const strip = (s: string): string =>
    s
      .replace(/<\/?details[^>]*>/g, '')
      .replace(/<summary>.*?<\/summary>/g, '')
      .split('\n')
      .map((l) => l.replace(/^> /, ''))
      .join('\n')
      .trim();
  if (close < 0) {
    // Still streaming the thinking block.
    return { thinking: strip(afterTag), answer: raw.slice(0, open) };
  }
  return {
    thinking: strip(afterTag.slice(0, close)),
    answer: raw.slice(0, open) + afterTag.slice(close + '</details>'.length),
  };
}

/** Feed one SSE `data:` payload; returns deltas and whether the turn ended. */
export function parseZaiSsePayload(payload: string): { deltas: ZaiDelta[]; done: boolean } {
  const deltas: ZaiDelta[] = [];
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return { deltas, done: false };
  }
  if (!obj || typeof obj !== 'object') return { deltas, done: false };
  const data = (obj as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return { deltas, done: false };
  const d = data as { phase?: unknown; delta_content?: unknown; edit_content?: unknown; content?: unknown };
  if (d.phase === 'done') return { deltas, done: true };
  const text =
    typeof d.delta_content === 'string' && d.delta_content
      ? d.delta_content
      : typeof d.edit_content === 'string' && d.edit_content
        ? d.edit_content
        : typeof d.content === 'string'
          ? d.content
          : '';
  if (!text) return { deltas, done: false };
  // NOTE: when a <details> thinking block spans frames, per-frame splits
  // misclassify. Prefer ZaiStreamAccumulator for real streams.
  const { thinking, answer } = splitZaiThinking(text);
  if (thinking) deltas.push({ kind: 'think', text: thinking });
  if (answer) deltas.push({ kind: 'answer', text: answer });
  return { deltas, done: false };
}

/**
 * Accumulates raw Z.ai stream text across SSE frames and emits only the new
 * thinking/answer deltas. Required because a <details> thinking block usually
 * spans several frames — splitting each frame in isolation misclassifies the
 * tail (stray </details> tags leak into the answer).
 */
export class ZaiStreamAccumulator {
  private raw = '';
  private sentThinking = '';
  private sentAnswer = '';

  /** Feed raw delta text from one frame; returns the new deltas. */
  push(text: string): ZaiDelta[] {
    this.raw += text;
    const { thinking, answer } = splitZaiThinking(this.raw);
    const deltas: ZaiDelta[] = [];
    if (thinking.startsWith(this.sentThinking)) {
      if (thinking.length > this.sentThinking.length) {
        deltas.push({ kind: 'think', text: thinking.slice(this.sentThinking.length) });
      }
      this.sentThinking = thinking;
    } else {
      this.sentThinking = thinking;
    }
    if (answer.startsWith(this.sentAnswer)) {
      if (answer.length > this.sentAnswer.length) {
        deltas.push({ kind: 'answer', text: answer.slice(this.sentAnswer.length) });
      }
      this.sentAnswer = answer;
    } else {
      this.sentAnswer = answer;
    }
    return deltas;
  }

  final(): { thinking: string; answer: string } {
    return splitZaiThinking(this.raw);
  }
}

/** Extract raw text from one SSE payload (no thinking split). */
export function zaiSseText(payload: string): { text: string; done: boolean } {
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return { text: '', done: false };
  }
  if (!obj || typeof obj !== 'object') return { text: '', done: false };
  const data = (obj as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return { text: '', done: false };
  const d = data as { phase?: unknown; delta_content?: unknown; edit_content?: unknown; content?: unknown };
  if (d.phase === 'done') return { text: '', done: true };
  const text =
    typeof d.delta_content === 'string' && d.delta_content
      ? d.delta_content
      : typeof d.edit_content === 'string' && d.edit_content
        ? d.edit_content
        : typeof d.content === 'string'
          ? d.content
          : '';
  return { text, done: false };
}

// ---------------------------------------------------------------------------
// Chat turn
// ---------------------------------------------------------------------------

export interface ZaiChatMessage {
  role: string;
  content: string;
}

export interface ZaiChatOptions extends FetchOpts {
  model: string;
  thinkingEnabled?: boolean;
  searchEnabled?: boolean;
  feVersion?: string;
  saltKey?: string;
  onDelta?: (d: ZaiDelta) => void;
}

/**
 * Run one chat turn against chat.z.ai and return the full text.
 * `signature_prompt` is the last user message; the whole history goes in
 * `messages`. Each turn uses a fresh chat_id like the web client.
 */
export async function zaiChat(
  baseUrl: string,
  token: string,
  messages: ZaiChatMessage[],
  opts: ZaiChatOptions,
): Promise<{ thinking: string; answer: string }> {
  const identity = decodeZaiToken(token);
  if (!identity) throw new ZaiWebError('invalid Z.ai token', 401);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const saltKey = opts.saltKey ?? ZAI_SALT_KEY_FALLBACK;
  const feVersion = opts.feVersion ?? ZAI_FE_VERSION_FALLBACK;
  const sig = signZaiRequest(prompt, token, identity.id, saltKey);

  const body = {
    model: opts.model,
    chat_id: randomUUID(),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    signature_prompt: prompt,
    stream: true,
    params: {},
    extra: {},
    features: {
      enable_thinking: opts.thinkingEnabled !== false,
      web_search: !!opts.searchEnabled,
      auto_web_search: !!opts.searchEnabled,
      image_generation: false,
      preview_mode: false,
      flags: [],
    },
    variables: {
      '{{USER_NAME}}': identity.email ? identity.email.split('@')[0] : 'User',
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': new Date().toISOString().replace('T', ' ').slice(0, 19),
      '{{USER_LANGUAGE}}': 'en-US',
    },
    background_tasks: { title_generation: true, tags_generation: true },
  };

  let r: Response;
  try {
    r = await zaiFetch(
      baseUrl,
      `/api/v2/chat/completions?${sig.query}`,
      {
        method: 'POST',
        headers: { ...authHeaders(token), 'x-signature': sig.signature, 'x-fe-version': feVersion },
        body: JSON.stringify(body),
      },
      opts,
    );
  } catch (e) {
    throw new ZaiWebError(e instanceof Error ? e.message : 'network error', 502);
  }
  if (r.status === 401 || r.status === 403) {
    throw new ZaiWebError('z.ai token rejected — reconnect the account', 401);
  }
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '');
    throw new ZaiWebError(`z.ai chat failed (${r.status})${t ? `: ${t.slice(0, 160)}` : ''}`, r.status);
  }

  const acc = new ZaiStreamAccumulator();
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        const { text, done: finished } = zaiSseText(payload);
        for (const d of acc.push(text)) opts.onDelta?.(d);
        if (finished) return acc.final();
      }
    }
  } finally {
    reader.releaseLock();
  }
  return acc.final();
}

/** Live model list for /v1/models synthesis. Falls back to known models. */
export async function listZaiModels(baseUrl: string, token: string, opts: FetchOpts = {}): Promise<string[]> {
  try {
    const r = await zaiFetch(baseUrl, '/api/models', { headers: authHeaders(token) }, { ...opts, timeoutMs: 15_000 });
    if (!r.ok) return [];
    const j = (await r.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const ids = Array.isArray(j?.data)
      ? j!.data.map((m) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean)
      : [];
    return ids.length > 0 ? ids : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// OpenAI-format completion (what upstreamClient consumes)
// ---------------------------------------------------------------------------

export interface ZaiWebRequest {
  baseUrl: string;
  credential: string;
  /** Resolved Z.ai web model id. */
  model: string;
  messages: { role?: string; content?: unknown }[];
  stream: boolean;
  /** Model name reported back to the client (the requested name). */
  responseModel?: string;
  thinkingEnabled?: boolean;
  searchEnabled?: boolean;
  signal?: AbortSignal;
  dispatcher?: unknown;
}

const sseEncoder = new TextEncoder();

function flattenZaiMessages(messages: { role?: string; content?: unknown }[]): ZaiChatMessage[] {
  const out: ZaiChatMessage[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (!content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n' + content;
    else out.push({ role, content });
  }
  return out;
}

function zaiChunk(model: string, delta: Record<string, unknown>, finish: string | null): string {
  return (
    `data: ${JSON.stringify({
      id: `zai-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  );
}

/**
 * ReadableStream: OpenAI-format SSE when stream=true, or a single JSON
 * completion object when stream=false.
 */
export async function zaiChatCompletion(req: ZaiWebRequest): Promise<ReadableStream<Uint8Array>> {
  const messages = flattenZaiMessages(req.messages);
  if (messages.length === 0) throw new ZaiWebError('empty prompt', 400);
  const outModel = req.responseModel ?? req.model;

  const chatOpts: ZaiChatOptions = {
    model: req.model,
    thinkingEnabled: req.thinkingEnabled !== false,
    searchEnabled: !!req.searchEnabled,
    dispatcher: req.dispatcher,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  if (!req.stream) {
    const { thinking, answer } = await zaiChat(req.baseUrl, req.credential, messages, chatOpts);
    const completion = {
      id: `zai-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: outModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: answer, ...(thinking ? { reasoning_content: thinking } : {}) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const bytes = sseEncoder.encode(JSON.stringify(completion));
    return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
  }

  // Streaming: translate Z.ai SSE to OpenAI chunks on the fly.
  const identity = decodeZaiToken(req.credential);
  if (!identity) throw new ZaiWebError('invalid Z.ai token', 401);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = lastUser?.content ?? '';
  const sig = signZaiRequest(prompt, req.credential, identity.id, ZAI_SALT_KEY_FALLBACK);

  const body = {
    model: req.model,
    chat_id: randomUUID(),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    signature_prompt: prompt,
    stream: true,
    params: {},
    extra: {},
    features: {
      enable_thinking: req.thinkingEnabled !== false,
      web_search: !!req.searchEnabled,
      auto_web_search: !!req.searchEnabled,
      image_generation: false,
      preview_mode: false,
      flags: [],
    },
    variables: {
      '{{USER_NAME}}': identity.email ? identity.email.split('@')[0] : 'User',
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': new Date().toISOString().replace('T', ' ').slice(0, 19),
      '{{USER_LANGUAGE}}': 'en-US',
    },
    background_tasks: { title_generation: true, tags_generation: true },
  };

  let upstream: Response;
  try {
    upstream = await zaiFetch(
      req.baseUrl,
      `/api/v2/chat/completions?${sig.query}`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(req.credential),
          'x-signature': sig.signature,
          'x-fe-version': ZAI_FE_VERSION_FALLBACK,
        },
        body: JSON.stringify(body),
      },
      { dispatcher: req.dispatcher, timeoutMs: DEFAULT_TIMEOUT_MS },
    );
  } catch (e) {
    throw new ZaiWebError(e instanceof Error ? e.message : 'network error', 502);
  }
  if (upstream.status === 401 || upstream.status === 403) {
    throw new ZaiWebError('z.ai token rejected — reconnect the account', 401);
  }
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text().catch(() => '');
    throw new ZaiWebError(`z.ai chat failed (${upstream.status})${t ? `: ${t.slice(0, 160)}` : ''}`, upstream.status);
  }

  const upstreamBody = upstream.body;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sentRole = false;
      const send = (s: string): void => {
        try {
          controller.enqueue(sseEncoder.encode(s));
        } catch {
          /* client gone */
        }
      };
      const sendRole = (): void => {
        if (sentRole) return;
        sentRole = true;
        send(zaiChunk(outModel, { role: 'assistant' }, null));
      };
      try {
        const acc = new ZaiStreamAccumulator();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            const { text, done: finished } = zaiSseText(payload);
            for (const d of acc.push(text)) {
              sendRole();
              send(zaiChunk(outModel, d.kind === 'think' ? { reasoning_content: d.text } : { content: d.text }, null));
            }
            if (finished) {
              send(zaiChunk(outModel, {}, 'stop'));
              send('data: [DONE]\n\n');
              controller.close();
              return;
            }
          }
        }
        send(zaiChunk(outModel, {}, 'stop'));
        send('data: [DONE]\n\n');
        controller.close();
      } catch (e) {
        controller.error(e);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
