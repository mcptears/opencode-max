/**
 * Native Qwen web-chat provider — Qwen runs *inside* opencode-max, no
 * separate qwen2api deployment needed.
 *
 * Protocol (chat.qwen.ai private web API):
 *   1. Auth: the account credential is either the `token` from
 *      chat.qwen.ai localStorage, or a Cookie header. It is sent with
 *      `source: web` — Bearer + `source: desktop` trips Qwen's
 *      FAIL_SYS_USER_VALIDATE risk control, so Cookie is preferred when the
 *      credential looks like one.
 *   2. POST /api/v2/chats/new -> { success, data: { id } }
 *   3. POST /api/v2/chat/completions?chat_id=<id> (SSE) with a single
 *      flattened user message; phases: think / thinking_summary (reasoning),
 *      answer (content).
 *   4. Best-effort chat cleanup afterwards.
 *
 * Risk-control responses (FAIL_SYS_USER_VALIDATE, RGV587_ERROR, captcha)
 * arrive as HTTP 200 JSON instead of an event stream and are surfaced as
 * 429s so the pool parks the account in cooldown instead of burning it.
 */

export class QwenWebError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'QwenWebError';
  }
}

export interface QwenWebRequest {
  baseUrl: string;
  /** localStorage token or Cookie header value from chat.qwen.ai. */
  credential: string;
  /** Resolved Qwen web model id, e.g. "qwen3.7-plus". */
  model: string;
  /** OpenAI-format messages; flattened into one prompt (disposable chats). */
  messages: { role?: string; content?: unknown }[];
  /** True when the client asked for SSE. */
  stream: boolean;
  /** Model name reported back to the client (defaults to the Qwen model id). */
  responseModel?: string;
  signal?: AbortSignal;
  /** undici dispatcher for proxy rotation (optional). */
  dispatcher?: unknown;
}

/** Map an opencode-max model name to a Qwen web model id. */
export function resolveQwenModel(
  modelMap: Record<string, string> | undefined,
  defaultModel: string,
  requested: string | undefined,
): string {
  if (requested && modelMap) {
    const hit = Object.entries(modelMap).find(([k]) => k.toLowerCase() === requested.toLowerCase());
    if (hit) return hit[1];
  }
  return defaultModel;
}

/** A pasted Cookie header contains '=' / ';' — send it as Cookie, else Bearer. */
export function qwenAuthHeaders(credential: string): Record<string, string> {
  const c = credential.trim();
  if (c.includes('=') || c.includes(';')) {
    const cookie = c.replace(/^Cookie:\s*/i, '');
    return { cookie };
  }
  return { authorization: `Bearer ${c}` };
}

function headers(credential: string): Record<string, string> {
  return {
    ...qwenAuthHeaders(credential),
    'content-type': 'application/json',
    source: 'web',
    'x-request-id': crypto.randomUUID(),
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  };
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Flatten OpenAI messages into one prompt — disposable chats carry no history. */
export function flattenMessages(messages: { role?: string; content?: unknown }[]): string {
  const parts: string[] = [];
  for (const m of messages ?? []) {
    const role = typeof m.role === 'string' ? m.role : 'user';
    const text = textContent(m.content).trim();
    if (!text) continue;
    if (role === 'system') parts.push(text);
    else parts.push(`[${role === 'assistant' ? 'Assistant' : 'User'}]: ${text}`);
  }
  return parts.join('\n\n');
}

interface FetchOpts {
  signal?: AbortSignal;
  dispatcher?: unknown;
}

async function qwenFetch(baseUrl: string, credential: string, path: string, init: RequestInit, opts: FetchOpts): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: { ...headers(credential), ...init.headers },
    signal: opts.signal,
    dispatcher: opts.dispatcher,
  } as RequestInit & { dispatcher?: unknown });
}

/** SHA-256 hex digest (used for the sign-in password — the plaintext never leaves the browser). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type QwenLoginResult = { ok: true; credential: string } | { ok: false; error: string };

function parseSetCookie(header: string): { name: string; value: string } | null {
  const m = /^([^=;]+)=([^;]*)/.exec(header.trim());
  return m ? { name: m[1].trim(), value: m[2].trim() } : null;
}

function signinError(status: number, bodyText: string): string {
  if (status === 401 || status === 403) return 'email or password incorrect';
  if (status === 429) return 'too many sign-in attempts — wait a bit and retry';
  const t = bodyText.slice(0, 160);
  return `qwen sign-in failed (${status})${t ? `: ${t}` : ''}`;
}

/**
 * Sign in with a Qwen account — the same call the chat.qwen.ai web frontend
 * makes. `passwordHash` must be the SHA-256 hex of the password, so the
 * plaintext password never reaches this server. Only the session credential
 * (token cookie) is returned; nothing is persisted here.
 */
export async function qwenSignIn(
  baseUrl: string,
  email: string,
  passwordHash: string,
  opts: FetchOpts = {},
): Promise<QwenLoginResult> {
  const base = baseUrl.replace(/\/+$/, '');
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      source: 'web',
      'x-request-id': crypto.randomUUID(),
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
    body: JSON.stringify({ email, password: passwordHash }),
  };
  for (const path of ['/api/v1/auths/signin', '/api/v2/auths/signin']) {
    let r: Response;
    try {
      r = await fetch(`${base}${path}`, { ...init, signal: opts.signal, dispatcher: opts.dispatcher } as RequestInit & {
        dispatcher?: unknown;
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'network error' };
    }
    if (r.status === 404) continue; // endpoint version drift — try the other
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: signinError(r.status, t) };
    }
    // Prefer the token cookie (chat auth rides on Cookie + source: web);
    // fall back to a token in the JSON body.
    const rawCookies: string[] =
      typeof (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (r.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    for (const h of rawCookies) {
      const c = parseSetCookie(h);
      if (c && c.name.toLowerCase() === 'token' && c.value) {
        return { ok: true, credential: `token=${c.value}` };
      }
    }
    const j = (await r.json().catch(() => null)) as { token?: unknown } | null;
    if (j && typeof j.token === 'string' && j.token) {
      return { ok: true, credential: `token=${j.token}` };
    }
    return { ok: false, error: 'sign-in succeeded but Qwen returned no session token' };
  }
  return { ok: false, error: 'qwen sign-in endpoint not found' };
}

/** Lightweight credential check: list chats. 200 = the credential works. */
export async function validateQwenCredential(
  baseUrl: string,
  credential: string,
  opts: FetchOpts = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await qwenFetch(baseUrl, credential, '/api/v2/chats/?page=1&exclude_project=true', { method: 'GET' }, opts);
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'token rejected (401/403) — sign in again and paste a fresh token' };
    if (!r.ok) return { ok: false, error: `qwen web api returned ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}

async function createChat(baseUrl: string, credential: string, model: string, opts: FetchOpts): Promise<string> {
  const r = await qwenFetch(
    baseUrl,
    credential,
    '/api/v2/chats/new',
    {
      method: 'POST',
      body: JSON.stringify({ title: 'New Chat', models: [model], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() }),
    },
    opts,
  );
  if (r.status === 401 || r.status === 403) throw new QwenWebError('qwen token rejected — reconnect the account', 401);
  if (!r.ok) throw new QwenWebError(`qwen create-chat failed (${r.status})`, r.status >= 500 ? 502 : r.status);
  const j = (await r.json().catch(() => null)) as { data?: { id?: string } } | null;
  const id = j?.data?.id;
  if (!id) throw new QwenWebError('qwen create-chat returned no chat id', 502);
  return id;
}

/** Best-effort cleanup of the disposable chat; never throws. */
async function deleteChat(baseUrl: string, credential: string, chatId: string, opts: FetchOpts): Promise<void> {
  try {
    await qwenFetch(baseUrl, credential, `/api/v2/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' }, opts);
  } catch {
    /* ignore — chats are disposable */
  }
}

interface QwenDelta {
  kind: 'think' | 'answer' | null;
  text: string;
}

/** Parse one SSE `data:` payload into a think/answer delta. */
export function parseQwenDelta(payload: string): QwenDelta | null {
  let obj: { choices?: { delta?: { phase?: string; content?: string } }[] };
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  const delta = obj?.choices?.[0]?.delta;
  if (!delta || typeof delta.content !== 'string' || !delta.content) return null;
  const phase = delta.phase;
  if (phase === 'think' || phase === 'thinking_summary') return { kind: 'think', text: delta.content };
  if (phase === 'answer' || phase == null) return { kind: 'answer', text: delta.content };
  return null;
}

const RISK_PATTERNS = /FAIL_SYS_USER_VALIDATE|RGV587_ERROR|captcha|verification/i;

function riskControlError(text: string): QwenWebError | null {
  if (RISK_PATTERNS.test(text)) {
    return new QwenWebError('qwen risk control triggered — account parked in cooldown', 429);
  }
  return null;
}

const sseEncoder = new TextEncoder();

function openAiChunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null): string {
  return (
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  );
}

/**
 * Run one Qwen web chat turn and return the upstream-facing body as a
 * ReadableStream: OpenAI-format SSE when stream=true, or a single JSON
 * chat.completion object otherwise. Owns the disposable chat lifecycle.
 */
export async function qwenChatCompletion(req: QwenWebRequest): Promise<ReadableStream<Uint8Array>> {
  const prompt = flattenMessages(req.messages);
  if (!prompt) throw new QwenWebError('empty prompt', 400);
  const opts: FetchOpts = { signal: req.signal, dispatcher: req.dispatcher };
  const chatId = await createChat(req.baseUrl, req.credential, req.model, opts);

  const fid = crypto.randomUUID();
  let upstream: Response;
  try {
    upstream = await qwenFetch(
      req.baseUrl,
      req.credential,
      `/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          stream: true,
          incremental_output: true,
          chat_id: chatId,
          chat_mode: 'normal',
          model: req.model,
          parent_id: null,
          messages: [
            {
              fid,
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: prompt,
              user_action: 'chat',
              files: [],
              timestamp: Math.floor(Date.now() / 1000),
              models: [req.model],
              chat_type: 't2t',
              feature_config: {
                thinking_enabled: true,
                output_schema: 'phase',
                auto_thinking: true,
                research_mode: 'normal',
                auto_search: false,
              },
              sub_chat_type: 't2t',
              parent_id: null,
            },
          ],
        }),
      },
      opts,
    );
  } catch (e) {
    void deleteChat(req.baseUrl, req.credential, chatId, opts);
    throw e;
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  // Risk control arrives as HTTP 200 JSON, not an event stream.
  if (!contentType.includes('text/event-stream')) {
    const text = await upstream.text().catch(() => '');
    void deleteChat(req.baseUrl, req.credential, chatId, opts);
    if (upstream.status === 401 || upstream.status === 403) throw new QwenWebError('qwen token rejected — reconnect the account', 401);
    throw riskControlError(text) ?? new QwenWebError(`qwen completions failed (${upstream.status})`, upstream.status >= 500 ? 502 : upstream.status);
  }

  const completionId = `chatcmpl-qwen-${chatId.slice(0, 8)}`;
  const outModel = req.responseModel ?? req.model;
  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    void deleteChat(req.baseUrl, req.credential, chatId, opts);
    throw new QwenWebError('qwen returned an empty stream', 502);
  }

  let finished = false;
  const finishUp = (): void => {
    if (!finished) {
      finished = true;
      void deleteChat(req.baseUrl, req.credential, chatId, opts);
    }
  };

  // Non-streaming: collect the whole turn, then emit one JSON completion.
  if (!req.stream) {
    const collect = async (): Promise<Uint8Array> => {
      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let reasoning = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            const d = parseQwenDelta(payload);
            if (!d) continue;
            if (d.kind === 'think') reasoning += d.text;
            else if (d.kind === 'answer') content += d.text;
          }
        }
      } finally {
        reader.releaseLock();
        finishUp();
      }
      if (!content && !reasoning) throw new QwenWebError('qwen returned an empty completion', 502);
      const completion = {
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: outModel,
        choices: [{ index: 0, message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return sseEncoder.encode(JSON.stringify(completion));
    };
    const bytes = await collect();
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }

  // Streaming: translate Qwen SSE phases to OpenAI chunks on the fly.
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
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            const d = parseQwenDelta(payload);
            if (!d) continue;
            if (!sentRole) {
              sentRole = true;
              send(openAiChunk(completionId, outModel, { role: 'assistant', content: '' }, null));
            }
            send(openAiChunk(completionId, outModel, d.kind === 'think' ? { reasoning_content: d.text } : { content: d.text }, null));
          }
        }
        send(openAiChunk(completionId, outModel, {}, 'stop'));
        send('data: [DONE]\n\n');
      } catch (e) {
        controller.error(e);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
        finishUp();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
    cancel() {
      finishUp();
    },
  });
}
