/**
 * Native DeepSeek web-chat provider — DeepSeek runs *inside* opencode-max, no
 * separate proxy deployment needed.
 *
 * Protocol (chat.deepseek.com private web API, reverse-engineered):
 *   Auth: POST /api/v0/users/login {email, mobile:"", password, area_code:"",
 *         device_id, os:"web"} -> data.biz_data.user.token (opaque Bearer <redacted>
 *   Session probe: POST /api/v0/chat_session/create {} -> code 0 (live) /
 *         code 40003 (dead token — "Authorization Failed (invalid token)").
 *   Chat turn:
 *     1. POST /api/v0/chat_session/create {} -> data.biz_data.chat_session.id
 *     2. POST /api/v0/chat/create_pow_challenge {"target_path":"/api/v0/chat/completion"}
 *        -> data.biz_data.challenge {algorithm, challenge, salt, expire_at,
 *           difficulty, signature, target_path}
 *     3. Solve DeepSeekHashV1 locally (pure TS Keccak below, no WASM needed):
 *        find nonce in [0, difficulty) with
 *        DeepSeekHashV1("{salt}_{expire_at}_{nonce}") == challenge
 *     4. POST /api/v0/chat/completion with the x-ds-pow-response header
 *        (base64 of {algorithm, challenge, salt, answer, signature, target_path})
 *        and the x-client-* fingerprint headers. Response is a JSON-patch
 *        SSE stream (not OpenAI SSE).
 *     5. POST /api/v0/chat_session/delete (best-effort cleanup).
 *
 * DeepSeekHashV1 = Keccak-f[1600] with SHA-3 padding 0x06 but only rounds
 * 1..23 (round zero skipped). It is neither SHA3-256 nor Keccak-256.
 *
 * Caveat: private, undocumented endpoints — any upstream change can break this.
 */

export class DeepSeekWebError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'DeepSeekWebError';
  }
}

export interface DeepSeekWebRequest {
  baseUrl: string;
  /** userToken from chat.deepseek.com localStorage (or the login token). */
  credential: string;
  /** Resolved DeepSeek web model id, e.g. "deepseek-chat". */
  model: string;
  /** OpenAI-format messages; flattened into one prompt (disposable sessions). */
  messages: { role?: string; content?: unknown }[];
  /** True when the client asked for SSE. */
  stream: boolean;
  /** Model name reported back to the client (defaults to the DeepSeek model id). */
  responseModel?: string;
  /**
   * Web options resolved by the caller from the provider's modelMap
   * (model_type / thinking / search). Derived from the model name when omitted.
   */
  web?: DeepSeekResolvedModel;
  signal?: AbortSignal;
  /** undici dispatcher for proxy rotation (optional). */
  dispatcher?: unknown;
}

// ---------------------------------------------------------------------------
// DeepSeekHashV1 — Keccak-f[1600], rounds 1..23 only, rate 136, pad 0x06.
//
// Lanes are 64-bit; they are stored as two uint32 halves (Uint32Array) so
// the solver runs ~10x faster than a BigInt implementation.
// ---------------------------------------------------------------------------

const DS_ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Round constants as [lo, hi] uint32 pairs. */
const DS_RC_LO = new Uint32Array(24);
const DS_RC_HI = new Uint32Array(24);
for (let i = 0; i < 24; i++) {
  DS_RC_LO[i] = Number(DS_ROUND_CONSTANTS[i] & 0xffffffffn);
  DS_RC_HI[i] = Number((DS_ROUND_CONSTANTS[i] >> 32n) & 0xffffffffn);
}

const DS_ROTATION_OFFSETS: number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const DS_RATE = 136;

/** Keccak-f[1600] with rounds 1..23 only (DeepSeek skips round 0). State: 50 uint32s. */
function keccakF1600DS(s: Uint32Array): void {
  const c = new Uint32Array(10);
  const b = new Uint32Array(50);
  // DeepSeek's solver skips round 0 — start at RC[1].
  for (let r = 1; r < 24; r++) {
    // Theta
    for (let x = 0; x < 5; x++) {
      c[2 * x] = s[2 * x] ^ s[2 * (x + 5)] ^ s[2 * (x + 10)] ^ s[2 * (x + 15)] ^ s[2 * (x + 20)];
      c[2 * x + 1] = s[2 * x + 1] ^ s[2 * (x + 5) + 1] ^ s[2 * (x + 10) + 1] ^ s[2 * (x + 15) + 1] ^ s[2 * (x + 20) + 1];
    }
    for (let x = 0; x < 5; x++) {
      const x4 = ((x + 4) % 5) * 2;
      const x1 = ((x + 1) % 5) * 2;
      const dLo = c[x4] ^ ((c[x1] << 1) | (c[x1 + 1] >>> 31));
      const dHi = c[x4 + 1] ^ ((c[x1 + 1] << 1) | (c[x1] >>> 31));
      for (let y = 0; y < 5; y++) {
        const i = (x + 5 * y) * 2;
        s[i] ^= dLo;
        s[i + 1] ^= dHi;
      }
    }
    // Rho + Pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const src = x + 5 * y;
        const dst = y + 5 * ((2 * x + 3 * y) % 5);
        const off = DS_ROTATION_OFFSETS[src];
        const lo = s[src * 2];
        const hi = s[src * 2 + 1];
        let rLo: number;
        let rHi: number;
        if (off === 0) {
          rLo = lo;
          rHi = hi;
        } else if (off < 32) {
          rLo = (lo << off) | (hi >>> (32 - off));
          rHi = (hi << off) | (lo >>> (32 - off));
        } else {
          const o = off - 32;
          rLo = (hi << o) | (lo >>> (32 - o));
          rHi = (lo << o) | (hi >>> (32 - o));
        }
        b[dst * 2] = rLo;
        b[dst * 2 + 1] = rHi;
      }
    }
    // Chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = (x + 5 * y) * 2;
        const i1 = (((x + 1) % 5) + 5 * y) * 2;
        const i2 = (((x + 2) % 5) + 5 * y) * 2;
        s[i] = (b[i] ^ (~b[i1] & b[i2])) >>> 0;
        s[i + 1] = (b[i + 1] ^ (~b[i1 + 1] & b[i2 + 1])) >>> 0;
      }
    }
    // Iota
    s[0] ^= DS_RC_LO[r];
    s[1] ^= DS_RC_HI[r];
  }
}

/** XOR message bytes into the state (little-endian lanes). */
function xorInto(s: Uint32Array, bytes: Uint8Array, offset: number, len: number): void {
  for (let i = 0; i < len; i++) {
    const lane = ((offset + i) / 8) | 0;
    s[lane * 2 + (((offset + i) % 8) < 4 ? 0 : 1)] ^= bytes[i] << (8 * ((offset + i) % 4));
  }
}

/** DeepSeekHashV1 digest of a message (32 bytes). */
export function deepseekHashV1(message: Uint8Array): Uint8Array {
  const s = new Uint32Array(50);
  let offset = 0;
  while (offset + DS_RATE <= message.length) {
    xorInto(s, message, offset, DS_RATE);
    keccakF1600DS(s);
    offset += DS_RATE;
  }
  const block = new Uint8Array(DS_RATE);
  block.set(message.subarray(offset));
  block[message.length - offset] ^= 0x06;
  block[DS_RATE - 1] ^= 0x80;
  xorInto(s, block, 0, DS_RATE);
  keccakF1600DS(s);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (s[((i / 8) | 0) * 2 + (((i % 8) < 4) ? 0 : 1)] >>> (8 * (i % 4))) & 0xff;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path: string;
}

/**
 * Solve a DeepSeekHashV1 challenge: find nonce in [0, difficulty) with
 * DeepSeekHashV1("{salt}_{expire_at}_{nonce}") == challenge.
 * Yields to the event loop periodically so the server stays responsive.
 */
export async function solveDeepSeekPoW(ch: PowChallenge): Promise<number> {
  if (ch.algorithm !== 'DeepSeekHashV1') {
    throw new DeepSeekWebError(`unsupported DeepSeek PoW algorithm "${ch.algorithm}"`, 502);
  }
  const difficulty = Math.floor(Number(ch.difficulty));
  if (!Number.isFinite(difficulty) || difficulty <= 0) {
    throw new DeepSeekWebError('invalid DeepSeek PoW difficulty', 502);
  }
  const want = String(ch.challenge).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new DeepSeekWebError('invalid DeepSeek PoW challenge', 502);
  const prefix = `${ch.salt}_${ch.expire_at}_`;
  const enc = new TextEncoder();
  for (let nonce = 0; nonce < difficulty; nonce++) {
    const digest = toHex(deepseekHashV1(enc.encode(prefix + nonce)));
    if (digest === want) return nonce;
    if (nonce % 4096 === 4095) await new Promise((r) => setImmediate(r));
  }
  throw new DeepSeekWebError('DeepSeek PoW solution not found', 502);
}

/** Build the x-ds-pow-response header value for a solved challenge. */
export function powResponseHeader(ch: PowChallenge, answer: number): string {
  const payload = {
    algorithm: ch.algorithm,
    challenge: ch.challenge,
    salt: ch.salt,
    answer,
    signature: ch.signature,
    target_path: ch.target_path,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// Auth + session lifecycle
// ---------------------------------------------------------------------------

interface FetchOpts {
  signal?: AbortSignal;
  dispatcher?: unknown;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Browser-style device id accepted by the web login endpoint (88-char base64). */
export function generateDeviceId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = crypto.getRandomValues(new Uint8Array(85));
  let s = 'B';
  for (const b of bytes) s += alphabet[b % 64];
  return s + '==';
}

function baseHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    origin: 'https://chat.deepseek.com',
    referer: 'https://chat.deepseek.com/',
    'user-agent': UA,
  };
}

function sessionHeaders(credential: string, deviceId?: string): Record<string, string> {
  const h: Record<string, string> = {
    ...baseHeaders(),
    authorization: `Bearer ${credential.trim()}`,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': 'web',
    'x-client-version': '2.5.0',
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'x-device-id': deviceId ?? crypto.randomUUID(),
    'x-device-model': '',
    'accept-language': 'en',
  };
  return h;
}

async function dsFetch(baseUrl: string, path: string, init: RequestInit, opts: FetchOpts): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    ...init,
    signal: opts.signal,
    dispatcher: opts.dispatcher,
  } as RequestInit & { dispatcher?: unknown });
}

function bizData(j: unknown): { code?: unknown; biz_code?: unknown; biz_data?: unknown } | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as { data?: unknown };
  return o.data && typeof o.data === 'object' ? (o.data as { code?: unknown; biz_code?: unknown; biz_data?: unknown }) : null;
}

export type DeepSeekLoginResult = { ok: true; credential: string } | { ok: false; error: string };

function loginError(status: number, bodyText: string): string {
  if (status === 400 || status === 401 || status === 403) return 'email or password incorrect';
  if (status === 429) return 'too many sign-in attempts — wait a bit and retry';
  const t = bodyText.slice(0, 160);
  return `deepseek sign-in failed (${status})${t ? `: ${t}` : ''}`;
}

/**
 * Sign in with a DeepSeek account — the same call the chat.deepseek.com web
 * frontend makes. `passwordHash` must be the SHA-256 hex of the password, so
 * the plaintext password never reaches this server. Only the session token is
 * returned; nothing is persisted here.
 *
 * Note: every login invalidates the previous token for the account, so
 * reconnects are serialized by the caller.
 */
export async function deepseekSignIn(
  baseUrl: string,
  email: string,
  passwordHash: string,
  opts: FetchOpts = {},
): Promise<DeepSeekLoginResult> {
  let r: Response;
  try {
    r = await dsFetch(
      baseUrl,
      '/api/v0/users/login',
      {
        method: 'POST',
        headers: baseHeaders(),
        body: JSON.stringify({
          email,
          mobile: '',
          password: passwordHash,
          area_code: '',
          device_id: generateDeviceId(),
          os: 'web',
        }),
      },
      opts,
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
  const text = await r.text().catch(() => '');
  if (!r.ok) return { ok: false, error: loginError(r.status, text) };
  let j: unknown = null;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, error: 'deepseek sign-in returned invalid JSON' };
  }
  const d = bizData(j);
  const user = d?.biz_data && typeof d.biz_data === 'object' ? (d.biz_data as { user?: unknown }).user : null;
  const token = user && typeof user === 'object' ? (user as { token?: unknown }).token : null;
  if (typeof token === 'string' && token.trim()) return { ok: true, credential: token.trim() };
  const msg = d?.biz_data && typeof d.biz_data === 'object' ? String((d.biz_data as { biz_msg?: unknown }).biz_msg ?? '') : '';
  return { ok: false, error: msg ? `deepseek sign-in failed: ${msg}` : 'sign-in succeeded but DeepSeek returned no token' };
}

/**
 * Lightweight credential check: create a chat session and delete it.
 * A dead token answers code 40003 ("Authorization Failed (invalid token)").
 */
export async function validateDeepSeekCredential(
  baseUrl: string,
  credential: string,
  opts: FetchOpts = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const id = await createChatSession(baseUrl, credential, opts);
    await deleteChatSession(baseUrl, credential, id, opts);
    return { ok: true };
  } catch (e) {
    if (e instanceof DeepSeekWebError && e.status === 401) {
      return { ok: false, error: 'token rejected (invalid token) — sign in again and paste a fresh token' };
    }
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}

async function apiPost(baseUrl: string, credential: string, path: string, body: unknown, opts: FetchOpts, extraHeaders?: Record<string, string>): Promise<unknown> {
  const r = await dsFetch(
    baseUrl,
    path,
    { method: 'POST', headers: { ...sessionHeaders(credential), ...extraHeaders }, body: JSON.stringify(body) },
    opts,
  );
  const text = await r.text().catch(() => '');
  if (r.status === 401 || r.status === 403) throw new DeepSeekWebError('deepseek token rejected — reconnect the account', 401);
  let j: { code?: unknown; data?: unknown } | null = null;
  try {
    j = text ? (JSON.parse(text) as { code?: unknown; data?: unknown }) : null;
  } catch {
    throw new DeepSeekWebError(`deepseek ${path} returned invalid JSON (${r.status})`, r.status >= 500 ? 502 : r.status);
  }
  // A dead token answers code 40003 at the top level.
  if (j?.code === 40003) throw new DeepSeekWebError('deepseek token rejected — reconnect the account', 401);
  const d = bizData(j);
  if (d && d.code !== 0 && d.code !== undefined) {
    throw new DeepSeekWebError(`deepseek ${path} failed (code ${String(d.code)})`, 502);
  }
  return d?.biz_data ?? null;
}

async function createChatSession(baseUrl: string, credential: string, opts: FetchOpts): Promise<string> {
  const data = (await apiPost(baseUrl, credential, '/api/v0/chat_session/create', {}, opts)) as {
    chat_session?: { id?: unknown };
  } | null;
  const id = data?.chat_session?.id;
  if (typeof id !== 'string' || !id) throw new DeepSeekWebError('deepseek session create returned no id', 502);
  return id;
}

/** Best-effort session cleanup; never throws. */
async function deleteChatSession(baseUrl: string, credential: string, id: string, opts: FetchOpts): Promise<void> {
  try {
    await apiPost(baseUrl, credential, '/api/v0/chat_session/delete', { chat_session_id: id }, opts);
  } catch {
    /* ignore — sessions are disposable */
  }
}

async function createPowChallenge(baseUrl: string, credential: string, opts: FetchOpts): Promise<PowChallenge> {
  const data = (await apiPost(baseUrl, credential, '/api/v0/chat/create_pow_challenge', { target_path: '/api/v0/chat/completion' }, opts)) as {
    challenge?: PowChallenge;
  } | null;
  const ch = data?.challenge;
  if (!ch || typeof ch !== 'object' || !ch.challenge || !ch.salt) {
    throw new DeepSeekWebError('deepseek PoW challenge missing', 502);
  }
  return ch;
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

export interface DeepSeekResolvedModel {
  /** DeepSeek web model id to report upstream (deepseek-chat / deepseek-reasoner). */
  modelType: 'default' | 'expert' | 'thinking';
  thinkingEnabled: boolean;
  searchEnabled: boolean;
}

/** Map an opencode-max model name to a DeepSeek web model id. */
export function resolveDeepSeekModelName(
  modelMap: Record<string, string> | undefined,
  defaultModel: string,
  requested: string | undefined,
): string {
  if (requested && modelMap) {
    const hit = Object.entries(modelMap).find(([k]) => k.toLowerCase() === requested.toLowerCase());
    if (hit) return hit[1];
  }
  if (requested && requested.trim()) {
    const n = requested.trim().toLowerCase();
    if (DEEPSEEK_MODELS.includes(n)) return n;
  }
  return defaultModel;
}

/** Map an opencode-max model name to DeepSeek web options.
 *
 * Explicit model-name markers always win (`deepseek-reasoner` / `*think*` /
 * `*r1*` force DeepThink on, `*search*` forces web search on). Otherwise the
 * provider-level toggles apply as defaults.
 */
export function resolveDeepSeekModel(
  modelMap: Record<string, string> | undefined,
  defaultModel: string,
  requested: string | undefined,
  defaults?: { thinkingEnabled?: boolean; searchEnabled?: boolean },
): DeepSeekResolvedModel {
  const name = resolveDeepSeekModelName(modelMap, defaultModel, requested);
  const n = name.toLowerCase();
  const thinkingMarker = n.includes('reasoner') || /\br1\b/.test(n) || n.includes('think') || n.includes('reason');
  const searchMarker = n.includes('search');
  const thinking = thinkingMarker || (defaults?.thinkingEnabled ?? false);
  const search = searchMarker || (defaults?.searchEnabled ?? false);
  const expert = !thinking && (n.includes('expert') || n.includes('pro'));
  return {
    modelType: thinking ? 'thinking' : expert ? 'expert' : 'default',
    thinkingEnabled: thinking,
    searchEnabled: search,
  };
}

export const DEEPSEEK_MODELS = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-expert'];

// ---------------------------------------------------------------------------
// SSE — DeepSeek speaks a JSON-patch protocol, not OpenAI SSE.
// ---------------------------------------------------------------------------

export interface DeepSeekDelta {
  kind: 'think' | 'answer' | null;
  text: string;
  done?: boolean;
  usage?: number;
}

interface Fragment {
  type?: unknown;
  content?: unknown;
}

/**
 * Parse one SSE `data:` payload into a think/answer delta.
 *
 * Wire shapes (verified against live captures):
 *   {"v":{"response":{...,"fragments":[{"type":"THINK","content":".."}]}}}
 *   {"p":"response/fragments/-1/content","o":"APPEND","v":".."}
 *   {"v":".."}                          (bare continuation of the last path)
 *   {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":".."}]}
 *   {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":65}]}
 *   {"p":"response/status","o":"SET","v":"FINISHED"}
 */
export function parseDeepSeekDelta(payload: string, state: { fragmentType: string }): DeepSeekDelta[] {
  let obj: {
    v?: unknown;
    p?: unknown;
    o?: unknown;
  };
  try {
    obj = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];

  const kind = (): 'think' | 'answer' => (state.fragmentType === 'THINK' ? 'think' : 'answer');

  // New fragments announced as an array — the last one's type steers what
  // the following APPENDs mean. THINK fragments carry reasoning; anything
  // else is answer content.
  const setFragmentType = (frags: unknown): void => {
    if (!Array.isArray(frags) || frags.length === 0) return;
    const last = frags[frags.length - 1] as Fragment;
    const t = typeof last?.type === 'string' ? last.type.toUpperCase() : '';
    state.fragmentType = t;
  };

  if (typeof obj.p === 'string') {
    const p = obj.p;
    if (p === 'response/fragments' && Array.isArray(obj.v)) {
      setFragmentType(obj.v);
      const last = (obj.v as Fragment[])[(obj.v as Fragment[]).length - 1];
      if (typeof last?.content === 'string' && last.content) {
        return [{ kind: kind(), text: last.content }];
      }
      return [];
    }
    if ((p === 'response/fragments/-1/content' || p.endsWith('/content')) && typeof obj.v === 'string' && obj.v) {
      return [{ kind: kind(), text: obj.v as string }];
    }
    if ((p === 'response/status' || p === 'response/quasi_status') && obj.v === 'FINISHED') {
      return [{ kind: null, text: '', done: true }];
    }
    if (p === 'response' && obj.o === 'BATCH' && Array.isArray(obj.v)) {
      for (const item of obj.v as { p?: unknown; v?: unknown }[]) {
        if (item && item.p === 'accumulated_token_usage' && typeof item.v === 'number') {
          return [{ kind: null, text: '', usage: item.v }];
        }
      }
      return [];
    }
    return [];
  }

  // Initial envelope: {"v":{"response":{...,"fragments":[...]}}}
  const v = obj.v;
  if (v && typeof v === 'object') {
    const resp = (v as { response?: unknown }).response;
    if (resp && typeof resp === 'object') {
      const frags = (resp as { fragments?: unknown }).fragments;
      setFragmentType(frags);
      if (Array.isArray(frags)) {
        const deltas: DeepSeekDelta[] = [];
        for (const f of frags as Fragment[]) {
          if (typeof f?.content !== 'string' || !f.content) continue;
          const t = typeof f.type === 'string' ? f.type.toUpperCase() : '';
          deltas.push({ kind: t === 'THINK' ? 'think' : 'answer', text: f.content });
        }
        return deltas;
      }
    }
    return [];
  }

  // Bare continuation: {"v":"..."} — continues the last announced path.
  if (typeof v === 'string' && v) {
    return [{ kind: kind(), text: v }];
  }
  return [];
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

/** Flatten OpenAI messages into one prompt — disposable sessions carry no history. */
export function flattenDeepSeekMessages(messages: { role?: string; content?: unknown }[]): string {
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

const sseEncoder = new TextEncoder();

function openAiChunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null): string {
  return (
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  );
}

/**
 * Run one DeepSeek web chat turn and return the upstream-facing body as a
 * ReadableStream: OpenAI-format SSE when stream=true, or a single JSON
 * chat.completion object otherwise. Owns the disposable session lifecycle.
 */
export async function deepseekChatCompletion(req: DeepSeekWebRequest): Promise<ReadableStream<Uint8Array>> {
  const prompt = flattenDeepSeekMessages(req.messages);
  if (!prompt) throw new DeepSeekWebError('empty prompt', 400);
  const opts: FetchOpts = { signal: req.signal, dispatcher: req.dispatcher };
  const base = req.baseUrl.replace(/\/+$/, '');
  // Web options (model_type / thinking / search) come from the caller when it
  // resolved the provider's modelMap; otherwise derive from the model name.
  const resolved = req.web ?? resolveDeepSeekModel(undefined, req.model, req.responseModel ?? req.model);

  const sessionId = await createChatSession(base, req.credential, opts);
  const finishSession = (): void => {
    void deleteChatSession(base, req.credential, sessionId, opts);
  };

  let upstream: Response;
  try {
    const challenge = await createPowChallenge(base, req.credential, opts);
    const answer = await solveDeepSeekPoW(challenge);
    const deviceId = crypto.randomUUID();
    upstream = await dsFetch(
      base,
      '/api/v0/chat/completion',
      {
        method: 'POST',
        headers: {
          ...sessionHeaders(req.credential, deviceId),
          'x-ds-pow-response': powResponseHeader(challenge, answer),
        },
        body: JSON.stringify({
          chat_session_id: sessionId,
          parent_message_id: null,
          model_type: resolved.modelType,
          prompt,
          ref_file_ids: [],
          thinking_enabled: resolved.thinkingEnabled,
          search_enabled: resolved.searchEnabled,
          action: null,
          preempt: false,
        }),
      },
      opts,
    );
  } catch (e) {
    finishSession();
    throw e;
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const text = await upstream.text().catch(() => '');
    finishSession();
    if (upstream.status === 401 || upstream.status === 403) {
      throw new DeepSeekWebError('deepseek token rejected — reconnect the account', 401);
    }
    if (upstream.status === 429) throw new DeepSeekWebError('deepseek rate limited — account parked in cooldown', 429);
    throw new DeepSeekWebError(`deepseek completions failed (${upstream.status})${text.slice(0, 120) ? `: ${text.slice(0, 120)}` : ''}`, upstream.status >= 500 ? 502 : upstream.status);
  }

  const completionId = `chatcmpl-ds-${sessionId.slice(0, 8)}`;
  const outModel = req.responseModel ?? req.model;
  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    finishSession();
    throw new DeepSeekWebError('deepseek returned an empty stream', 502);
  }

  let finished = false;
  const finishUp = (): void => {
    if (!finished) {
      finished = true;
      finishSession();
    }
  };

  /** Shared SSE consumer: feeds parsed deltas to `onDelta`, stops at FINISHED. */
  const consume = async (onDelta: (d: DeepSeekDelta) => void): Promise<void> => {
    const reader = upstreamBody.getReader();
    const decoder = new TextDecoder();
    const state = { fragmentType: '' };
    let buffer = '';
    let eventType = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) {
            eventType = '';
            continue;
          }
          if (t.startsWith('event:')) {
            eventType = t.slice(6).trim();
            continue;
          }
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          if (eventType && eventType !== 'message' && eventType !== 'data') continue;
          for (const d of parseDeepSeekDelta(payload, state)) {
            onDelta(d);
            if (d.done) return;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      finishUp();
    }
  };

  // Non-streaming: collect the whole turn, then emit one JSON completion.
  if (!req.stream) {
    let content = '';
    let reasoning = '';
    let usage: number | undefined;
    await consume((d) => {
      if (d.kind === 'think') reasoning += d.text;
      else if (d.kind === 'answer') content += d.text;
      if (typeof d.usage === 'number') usage = d.usage;
    });
    if (!content && !reasoning) throw new DeepSeekWebError('deepseek returned an empty completion', 502);
    const completion = {
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: outModel,
      choices: [{ index: 0, message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: usage ?? 0, total_tokens: usage ?? 0 },
    };
    const bytes = sseEncoder.encode(JSON.stringify(completion));
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }

  // Streaming: translate DeepSeek JSON-patch SSE to OpenAI chunks on the fly.
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let sentRole = false;
      const send = (s: string): void => {
        try {
          controller.enqueue(sseEncoder.encode(s));
        } catch {
          /* client gone */
        }
      };
      try {
        await consume((d) => {
          if (d.kind && d.text) {
            if (!sentRole) {
              sentRole = true;
              send(openAiChunk(completionId, outModel, { role: 'assistant', content: '' }, null));
            }
            send(openAiChunk(completionId, outModel, d.kind === 'think' ? { reasoning_content: d.text } : { content: d.text }, null));
          }
        });
        send(openAiChunk(completionId, outModel, {}, 'stop'));
        send('data: [DONE]\n\n');
      } catch (e) {
        controller.error(e);
      } finally {
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
