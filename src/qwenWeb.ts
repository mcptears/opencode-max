/**
 * Native Qwen web-chat provider — Qwen runs *inside* opencode-max, no
 * separate qwen2api deployment needed.
 *
 * Protocol (chat.qwen.ai private web API):
 *   1. Auth: the account credential is the `token` from chat.qwen.ai
 *      localStorage, sent as `Authorization: Bearer` — never with the
 *      browser's cookies: stale anti-bot cookies (tfstk, ssxmod_itna) next
 *      to a valid Bearer trip baxia risk control, while the same request
 *      Bearer-only passes (the working qwen2API reference does the same).
 *   2. POST /api/v2/chats/new -> { success, data: { id } }
 *   3. POST /api/v2/chat/completions?chat_id=<id> (SSE) with a single
 *      flattened user message; phases: think / thinking_summary (reasoning),
 *      answer (content).
 *   4. Best-effort chat cleanup afterwards.
 *
 * Risk-control responses (FAIL_SYS_USER_VALIDATE, RGV587_ERROR, captcha)
 * arrive as HTTP 200 JSON instead of an event stream and are surfaced as
 * 429s so the pool parks the account in cooldown instead of burning it.
 * Auth failures (expired/invalid token) also arrive as HTTP 200 JSON —
 * `{success:false,data:{code:"unauthorized",...}}` — never as 401, so the
 * response body must always be inspected; they surface as 401 so the pool
 * parks the account as invalid instead of retrying into 502s.
 */

import { Agent } from 'undici';

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
  /** Session cookies from chat.qwen.ai (document.cookie) — sent as Cookie header. */
  cookies?: string;
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

/** Baxia (Aliyun WAF) token version. */
const BAXIA_VERSION = '2.5.36';

/** Generate a random browser fingerprint for the bx-ua token. */
function baxiaFingerprint(): Record<string, unknown> {
  const platforms = ['Win32', 'Linux x86_64', 'MacIntel'];
  const languages = ['en-US', 'zh-CN', 'en-GB'];
  const renderers = [
    'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)',
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080, OpenGL 4.6)',
    'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.6)',
  ];
  return {
    p: platforms[Math.floor(Math.random() * platforms.length)],
    l: languages[Math.floor(Math.random() * languages.length)],
    hc: 4 + Math.floor(Math.random() * 12),
    dm: [4, 8, 16, 32][Math.floor(Math.random() * 4)],
    to: [-480, -300, 0, 60, 480][Math.floor(Math.random() * 5)],
    sw: 1920 + Math.floor(Math.random() * 200),
    sh: 1080 + Math.floor(Math.random() * 100),
    cd: 24,
    pr: [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)],
    wf: renderers[Math.floor(Math.random() * renderers.length)].substring(0, 20),
    cf: crypto.randomUUID().replace(/-/g, '').substring(0, 32),
    af: (124.04347527516074 + Math.random() * 0.001).toFixed(14),
    ts: Date.now(),
    r: Math.random(),
  };
}

/** bx-ua = version (dots removed) + '!' + base64(fingerprint JSON). */
function baxiaUa(): string {
  const json = JSON.stringify(baxiaFingerprint());
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return `${BAXIA_VERSION.replace(/\./g, '')}!${b64}`;
}

let bxUmidTokenCache: string | null = null;
let bxUmidTokenTime = 0;
const BX_UMID_TTL = 4 * 60 * 1000;

/** Fetch the T2gAv_ umid token from Alibaba's WU endpoint (cached 4 min). */
async function baxiaUmidToken(): Promise<string> {
  const now = Date.now();
  if (bxUmidTokenCache && now - bxUmidTokenTime < BX_UMID_TTL) return bxUmidTokenCache;
  try {
    const r = await fetch('https://sg-wum.alibaba.com/w/wu.json', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    const m = text.match(/umx\.wu\('([^']+)'\)/) || text.match(/'([^']+)'/);
    const token = (m && m[1]) || r.headers.get('etag') || '';
    if (token && /^T2gA/i.test(token)) {
      bxUmidTokenCache = token;
      bxUmidTokenTime = now;
      return token;
    }
  } catch {
    /* fall through to empty */
  }
  return '';
}

/** Baxia auth headers for Qwen web API (replaces Bearer/Cookie auth). */
export function qwenBaxiaHeaders(): Promise<Record<string, string>> {
  return baxiaUmidToken().then((umid) => ({
    'bx-ua': baxiaUa(),
    'bx-umidtoken': umid,
    'bx-v': BAXIA_VERSION,
  }));
}

/** A pasted Cookie header contains '=' / ';' — send it as Cookie, else Bearer. (Legacy; baxia is preferred.) */
export function qwenAuthHeaders(credential: string): Record<string, string> {
  const c = credential.trim();
  if (c.includes('=') || c.includes(';')) {
    const cookie = c.replace(/^Cookie:\s*/i, '');
    return { cookie };
  }
  return { authorization: `Bearer ${c}` };
}

async function headers(credential: string, cookies?: string): Promise<Record<string, string>> {
  const cred = credential?.trim();
  if (cred) {
    // Logged-in: Bearer token only, browser-like headers. No baxia.
    const h: Record<string, string> = {
      'Authorization': `Bearer ${cred.replace(/^token=/i, '')}`,
      'x-request-id': crypto.randomUUID(),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'https://chat.qwen.ai/',
      'Origin': 'https://chat.qwen.ai',
      'Connection': 'keep-alive',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    };
    // No Cookie here: stale browser anti-bot cookies next to a valid Bearer
    // trip baxia risk control (the reference client sends Bearer only).
    return h;
  }
  // Guest: baxia headers only.
  const baxia = await qwenBaxiaHeaders();
  const h: Record<string, string> = {
    'Accept': 'application/json',
    'content-type': 'application/json',
    'Origin': 'https://chat.qwen.ai',
    'Referer': 'https://chat.qwen.ai/c/guest',
    'source': 'web',
    'version': '0.2.83',
    'x-request-id': crypto.randomUUID(),
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  };
  if (baxia['bx-umidtoken']) Object.assign(h, baxia);
  if (cookies?.trim()) h['Cookie'] = cookies.trim();
  return h;
}

/** chat_mode: 'normal' for logged-in accounts, 'guest' when no credential. */
function chatMode(credential: string | undefined): string {
  return credential?.trim() ? 'normal' : 'guest';
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

// ============================================================================
// WAF hygiene (mirrors the production reference clients for this exact WAF):
//  - warm up with a GET to the site root first, collecting acw_tc-style cookies,
//  - keep a random 200-500 ms shared gap between upstream calls (bursts are
//    what trips the Aliyun WAF),
//  - reuse chats instead of one chat per request (chats/new is the most
//    aggressively challenged endpoint; one chat per message looks like a bot).
// ============================================================================

// Chrome-shaped TLS: Node's closest equivalent to the reference client's
// uTLS HelloChrome profile (Aliyun fingerprints TLS; Go's/Node's defaults
// are what get challenged).
let chromeTlsAgent: Agent | null = null;

function qwenDispatcher(override?: unknown): unknown {
  if (override) return override;
  if (!chromeTlsAgent) {
    chromeTlsAgent = new Agent({
      connect: {
        ciphers:
          'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
        ecdhCurve: 'X25519:P-256:P-384',
        sigalgs:
          'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
        ALPNProtocols: ['http/1.1'],
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
      },
    });
  }
  return chromeTlsAgent;
}

// --- per-host anti-bot cookie jar -------------------------------------------
const WARM_COOKIE_TTL_MS = 30 * 60 * 1000;
const ANTIBOT_COOKIE = /^(acw_|cdn_sec_tc|tfstk|cna|isg|xlly_s|x-ap|sca|atpsida|ssxmod_itna2?)$/i;
const cookieJar = new Map<string, Map<string, string>>();
let jarWarmedAt = 0;

function jarKey(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function jarHeaders(baseUrl: string): Record<string, string> {
  const jar = cookieJar.get(jarKey(baseUrl));
  if (!jar || jar.size === 0) return {};
  return { Cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
}

function harvestCookies(baseUrl: string, res: Response): void {
  const get = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const raw = typeof get === 'function' ? get.call(res.headers) : [];
  if (raw.length === 0) return;
  let jar = cookieJar.get(jarKey(baseUrl));
  if (!jar) {
    jar = new Map();
    cookieJar.set(jarKey(baseUrl), jar);
  }
  for (const line of raw) {
    const c = parseSetCookie(line);
    if (c && ANTIBOT_COOKIE.test(c.name)) jar.set(c.name, c.value);
  }
}

/** GET the site root once per TTL to collect acw_tc-style cookies into the jar. */
async function warmUpCookies(baseUrl: string): Promise<void> {
  if (Date.now() - jarWarmedAt < WARM_COOKIE_TTL_MS && cookieJar.has(jarKey(baseUrl))) return;
  try {
    const r = await fetch(`${jarKey(baseUrl)}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
      dispatcher: qwenDispatcher(),
    } as RequestInit & { dispatcher?: unknown });
    harvestCookies(baseUrl, r);
    void r.body?.cancel();
    jarWarmedAt = Date.now();
  } catch {
    /* best-effort */
  }
}

// --- WAF circuit breaker (ported from the working GLM/z.ai client) ----------
// Once the WAF challenges POSTs, retrying immediately makes it worse: fail
// fast with a retry hint and let one background prober decide when the block
// lifts (the cooldown doubles while it persists: 60s -> 30min).
let wafBaseCooldownMs = 60 * 1000;
let wafMaxCooldownMs = 30 * 60 * 1000;
let wafOpen = false;
let wafOpenedAt = 0;
let wafCooldownMs = 0;
let wafBlockCount = 0;
let wafProbeGen = 0;
let wafBaseUrl = 'https://chat.qwen.ai';

function wafRemainingMs(): number {
  if (!wafOpen) return 0;
  const remaining = wafOpenedAt + wafCooldownMs - Date.now();
  return remaining > 0 ? remaining : 0;
}

/** Fail fast while the breaker is open; probing is owned by the prober. */
function wafGate(): void {
  if (!wafOpen) return;
  throw new QwenWebError(`qwen WAF block active (Aliyun) — retry in ~${Math.max(1, Math.ceil(wafRemainingMs() / 1000))}s`, 503);
}

function wafRetryHint(): string {
  return `retry in ~${Math.max(1, Math.ceil(wafRemainingMs() / 1000))}s`;
}

function recordWafBlock(baseUrl: string): void {
  wafBaseUrl = jarKey(baseUrl);
  wafBlockCount++;
  if (wafOpen) return;
  wafOpen = true;
  wafOpenedAt = Date.now();
  wafCooldownMs = wafBaseCooldownMs;
  scheduleWafProbe(++wafProbeGen);
}

function recordWafSuccess(): void {
  if (!wafOpen && wafBlockCount === 0) return;
  wafOpen = false;
  wafBlockCount = 0;
  wafCooldownMs = 0;
  wafProbeGen++;
}

function scheduleWafProbe(gen: number): void {
  const timer = setTimeout(() => {
    void (async () => {
      if (gen !== wafProbeGen || !wafOpen) return;
      let blocked = true;
      try {
        // Bare POST to the challenged endpoint: a challenge page means still
        // blocked; anything else (even 400/403 JSON) proves the block lifted.
        const r = await fetch(`${wafBaseUrl}/api/v2/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...jarHeaders(wafBaseUrl) },
          body: '{}',
          signal: AbortSignal.timeout(15000),
          dispatcher: qwenDispatcher(),
        } as RequestInit & { dispatcher?: unknown });
        const text = await r.text().catch(() => '');
        blocked = WAF_CHALLENGE.test(text) || (r.status === 405 && /threat|blocked/i.test(text));
      } catch {
        blocked = true;
      }
      if (gen !== wafProbeGen || !wafOpen) return;
      if (blocked) {
        wafCooldownMs = Math.min(wafCooldownMs * 2, wafMaxCooldownMs);
        wafOpenedAt = Date.now();
        scheduleWafProbe(gen);
      } else {
        recordWafSuccess();
      }
    })();
  }, wafCooldownMs || wafBaseCooldownMs);
  timer.unref?.();
}

/** Test-only: shrink breaker timing and reset state between tests. */
export function __wafTestControls(baseMs: number, maxMs: number): void {
  wafBaseCooldownMs = baseMs;
  wafMaxCooldownMs = maxMs;
  wafOpen = false;
  wafBlockCount = 0;
  wafCooldownMs = 0;
  wafProbeGen++;
}

// Shared pacing gate: every upstream call claims the next start slot.
let paceNextSlot = 0;
let paceGapMs = 0;

async function pace(): Promise<void> {
  if (!paceGapMs) paceGapMs = 200 + Math.floor(Math.random() * 300);
  const now = Date.now();
  const slot = Math.max(now, paceNextSlot);
  paceNextSlot = slot + paceGapMs;
  const wait = slot - now;
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
}

async function qwenFetch(baseUrl: string, credential: string, path: string, init: RequestInit, opts: FetchOpts, cookies?: string): Promise<Response> {
  await pace();
  wafGate();
  await warmUpCookies(baseUrl);
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: { ...(await headers(credential, cookies)), ...jarHeaders(baseUrl), ...init.headers },
    signal: opts.signal,
    dispatcher: qwenDispatcher(opts.dispatcher),
  } as RequestInit & { dispatcher?: unknown });
  harvestCookies(baseUrl, res);
  return res;
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
  // Real Qwen returns 400 INVALID_CRED for wrong credentials.
  if (status === 400 && /INVALID_CRED|incorrect/i.test(bodyText)) return 'email or password incorrect';
  if (status === 429) return 'too many sign-in attempts — wait a bit and retry';
  const t = bodyText.slice(0, 160);
  return `qwen sign-in failed (${status})${t ? `: ${t}` : ''}`;
}

/**
 * Sign in with a Qwen account — the same call the chat.qwen.ai web frontend
 * makes. `passwordHash` must be the SHA-256 hex of the password, so the
 * plaintext password never reaches this server. The raw session token is
 * returned (callers send it as Bearer```); nothing is persisted here.
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
      const timeout = AbortSignal.timeout(30000);
      r = await fetch(`${base}${path}`, { ...init, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout, dispatcher: qwenDispatcher(opts.dispatcher) } as RequestInit & {
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
        return { ok: true, credential: c.value };
      }
    }
    const j = (await r.json().catch(() => null)) as { token?: unknown } | null;
    if (j && typeof j.token === 'string' && j.token) {
      return { ok: true, credential: j.token };
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
  cookies?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await qwenFetch(baseUrl, credential, '/api/v2/chats/?page=1&exclude_project=true', { method: 'GET' }, opts, cookies);
    const text = await r.text().catch(() => '');
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'token rejected (401/403) — sign in again and paste a fresh token' };
    if (!r.ok) return { ok: false, error: `qwen web api returned ${r.status}` };
    // Auth failures arrive as HTTP 200 + {success:false,data:{code:"unauthorized"}}.
    const j = parseUpstreamJson(text);
    if (j?.success === false) {
      if (tokenRejectedIn(j)) return { ok: false, error: `token expired or rejected — reconnect the account (upstream: ${upstreamErrorText(j)})` };
      return { ok: false, error: `qwen web api error: ${upstreamErrorText(j)}` };
    }
    if (WAF_CHALLENGE.test(text)) {
      recordWafBlock(baseUrl);
      return { ok: false, error: 'qwen WAF browser-verification challenge — retry shortly' };
    }
    if (TOKEN_REJECTED.test(text)) return { ok: false, error: 'token rejected — reconnect the account' };
    recordWafSuccess();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}

async function createChat(baseUrl: string, credential: string, model: string, opts: FetchOpts, cookies?: string): Promise<string> {
  const init: RequestInit = {
    method: 'POST',
    body: JSON.stringify({ title: 'New Chat', models: [model], chat_mode: chatMode(credential), chat_type: 't2t', timestamp: Date.now(), project_id: '' }),
  };
  // The WAF intermittently answers POSTs with a browser-verification page
  // (HTTP 200, HTML) instead of JSON. It clears on later attempts, so retry
  // briefly before surfacing it as a retriable 503.
  for (let attemptNo = 1; ; attemptNo++) {
    const r = await qwenFetch(baseUrl, credential, '/api/v2/chats/new', init, opts, cookies);
    if (r.status === 401 || r.status === 403) throw new QwenWebError('qwen token rejected — reconnect the account', 401);
    const bodyText = await r.text().catch(() => '');
    if (!r.ok) {
      throw new QwenWebError(`qwen create-chat failed (${r.status}): ${bodyText.slice(0, 300)}`, r.status >= 500 ? 502 : r.status);
    }
    if (WAF_CHALLENGE.test(bodyText)) {
      if (attemptNo < 3 && !opts.signal?.aborted) {
        await new Promise((res) => setTimeout(res, 1500 * attemptNo));
        continue;
      }
      recordWafBlock(baseUrl);
      throw new QwenWebError(`qwen WAF browser-verification challenge — ${wafRetryHint()}`, 503);
    }
    const j = parseUpstreamJson(bodyText);
  if (j?.success === false) {
    // Expired/invalid token (or anything auth-shaped) must surface as 401 so
    // the pool parks the account — not as a retriable 502.
    if (tokenRejectedIn(j)) throw new QwenWebError('qwen token rejected — reconnect the account', 401);
    throw riskControlError(bodyText) ?? new QwenWebError(`qwen create-chat failed: ${upstreamErrorText(j)}`, 502);
  }
    const id = typeof j?.data === 'object' ? j.data?.id : undefined;
    if (!id) throw new QwenWebError(`qwen create-chat returned no chat id: ${bodyText.slice(0, 300)}`, 502);
    recordWafSuccess();
    return id;
  }
}

/** Best-effort cleanup when retiring a warm chat; never throws. */
async function deleteChat(baseUrl: string, credential: string, chatId: string, opts: FetchOpts, cookies?: string): Promise<void> {
  try {
    await qwenFetch(baseUrl, credential, `/api/v2/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' }, opts, cookies);
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------------------------
// Warm chat pool: reuse one chat for several turns, then retire it.
// ----------------------------------------------------------------------------

const WARM_CHAT_REUSE = 10;
const WARM_CHAT_TTL_MS = 20 * 60 * 1000;

interface WarmChat {
  id: string;
  uses: number;
  created: number;
}

const warmChats = new Map<string, WarmChat>();
const warmChatInflight = new Map<string, Promise<string>>();

function warmChatKey(credential: string, model: string): string {
  return `${credential.slice(0, 40)}|${model}`;
}

/** Take a warm chat or create one; concurrent callers share the creation. */
async function takeChat(baseUrl: string, credential: string, model: string, opts: FetchOpts, cookies?: string): Promise<string> {
  const key = warmChatKey(credential, model);
  const cached = warmChats.get(key);
  if (cached && cached.uses < WARM_CHAT_REUSE && Date.now() - cached.created < WARM_CHAT_TTL_MS) {
    cached.uses++;
    return cached.id;
  }
  if (cached) {
    warmChats.delete(key);
    void deleteChat(baseUrl, credential, cached.id, opts, cookies);
  }
  const inflight = warmChatInflight.get(key);
  if (inflight) return inflight;
  const run = createChat(baseUrl, credential, model, opts, cookies)
    .then((id) => {
      warmChats.set(key, { id, uses: 1, created: Date.now() });
      return id;
    })
    .finally(() => warmChatInflight.delete(key));
  warmChatInflight.set(key, run);
  return run;
}

/** Drop a warm chat (upstream rejected it — e.g. expired or 404). */
function dropWarmChat(credential: string, model: string): void {
  warmChats.delete(warmChatKey(credential, model));
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

/** Aliyun WAF browser-verification page (arrives as HTTP 200 HTML, not JSON). */
const WAF_CHALLENGE = /<!doctype html|<html[^>]*>|aliyun_waf/i;

function riskControlError(text: string): QwenWebError | null {
  if (RISK_PATTERNS.test(text)) {
    const j = parseUpstreamJson(text);
    const detail = j ? ` (upstream: ${upstreamErrorText(j)})` : ` (upstream: ${text.slice(0, 120).replace(/\s+/g, ' ')})`;
    return new QwenWebError(`qwen risk control triggered — account parked in cooldown${detail}`, 429);
  }
  return null;
}

/** Shape of Qwen's JSON error bodies: `{success:false,data:{code,details}}`. */
interface QwenUpstreamErrorBody {
  success?: boolean;
  data?: { id?: string; code?: string; details?: string } | string;
  code?: string;
  details?: string;
  message?: string;
}

/** Upstream phrases that mean the credential is dead (body says so on HTTP 200). */
const TOKEN_REJECTED = /unauthorized|token has expired|no longer valid|please log in|invalid token|not logged in/i;

function parseUpstreamJson(text: string): QwenUpstreamErrorBody | null {
  try {
    return JSON.parse(text) as QwenUpstreamErrorBody;
  } catch {
    return null;
  }
}

/** True when an HTTP-200 body actually says the credential is dead. */
function tokenRejectedIn(j: QwenUpstreamErrorBody | null): boolean {
  if (!j || j.success !== false) return false;
  const data = typeof j.data === 'object' ? j.data : undefined;
  const code = data?.code ?? j.code ?? '';
  const details = data?.details ?? j.details ?? j.message ?? '';
  return TOKEN_REJECTED.test(`${code} ${details}`);
}

/** Human-readable code/details from a success:false body. */
function upstreamErrorText(j: QwenUpstreamErrorBody): string {
  const data = typeof j.data === 'object' ? j.data : undefined;
  const code = data?.code ?? j.code ?? 'upstream_error';
  const details = data?.details ?? j.details ?? j.message ?? '';
  return details ? `${code}: ${details}` : code;
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
  const chatId = await takeChat(req.baseUrl, req.credential, req.model, opts, req.cookies);

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
          version: '2.1',
          incremental_output: true,
          chat_id: chatId,
          chat_mode: chatMode(req.credential),
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
      req.cookies,
    );
  } catch (e) {
    throw e; // network-level: the warm chat stays reusable
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  // Risk control AND auth failures arrive as HTTP 200 JSON, not an event stream.
  if (!contentType.includes('text/event-stream')) {
    const text = await upstream.text().catch(() => '');
    if (upstream.status === 404 || upstream.status === 401 || upstream.status === 403) dropWarmChat(req.credential, req.model);
    if (upstream.status === 401 || upstream.status === 403) throw new QwenWebError('qwen token rejected — reconnect the account', 401);
    if (WAF_CHALLENGE.test(text)) {
      recordWafBlock(req.baseUrl);
      throw new QwenWebError(`qwen WAF browser-verification challenge — ${wafRetryHint()}`, 503);
    }
    const j = parseUpstreamJson(text);
    if (tokenRejectedIn(j)) throw new QwenWebError('qwen token rejected — reconnect the account', 401);
    throw riskControlError(text) ?? new QwenWebError(`qwen completions failed (${upstream.status}): ${text.slice(0, 300)}`, upstream.status >= 500 ? 502 : upstream.status);
  }

  recordWafSuccess();
  const completionId = `chatcmpl-qwen-${chatId.slice(0, 8)}`;
  const outModel = req.responseModel ?? req.model;
  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    dropWarmChat(req.credential, req.model);
    throw new QwenWebError('qwen returned an empty stream', 502);
  }

  let finished = false;
  const finishUp = (): void => {
    finished = true;
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
      if (!content && !reasoning) {
        dropWarmChat(req.credential, req.model);
        throw new QwenWebError('qwen returned an empty completion', 502);
      }
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
