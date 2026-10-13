# GLM-parity WAF stack: Chrome-ish TLS, cookie jar, circuit breaker, wiring.
import io

NL = '\r\n'
qw = r'E:\opencode-max\opencode-max\src\qwenWeb.ts'
lines = io.open(qw, encoding='utf-8', newline='').read().split(NL)


def find_exact(text, start=0):
    for i in range(start, len(lines)):
        if lines[i] == text:
            return i
    raise AssertionError('exact anchor not found: ' + text[:80])


def insert_before(pred, new_lines):
    for i in range(len(lines)):
        if pred(lines[i]):
            lines[i:i] = new_lines
            print('inserted before line', i + 1)
            return
    raise AssertionError('pred anchor not found')


def replace_exact(old, new):
    n = len(old)
    hits = [i for i in range(len(lines) - n + 1) if lines[i:i + n] == old]
    assert len(hits) == 1, f'expected 1 hit, got {len(hits)}: {old[0][:70]}'
    i = hits[0]
    lines[i:i + n] = new
    print('replaced', len(old), 'lines at', i + 1)


# ---- 1. import Agent ---------------------------------------------------------
insert_before(lambda l: l.startswith('export class QwenWebError'), ["import { Agent } from 'undici';", ''])

# ---- 2. replace hygiene block (warm-up + pacing + qwenFetch) -----------------
start = find_exact('const WARM_COOKIE_TTL_MS = 30 * 60 * 1000;')
doc = find_exact('/** SHA-256 hex digest (used for the sign-in password — the plaintext never leaves the browser). */', start)
end = doc - 2
assert lines[end] == '}' and lines[doc - 1] == '', (lines[end], lines[doc - 1])

new_block = '''// Chrome-shaped TLS: Node's closest equivalent to the reference client's
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
  return baseUrl.replace(/\\/+$/, '');
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
  const res = await fetch(`${baseUrl.replace(/\\/+$/, '')}${path}`, {
    ...init,
    headers: { ...(await headers(credential, cookies)), ...jarHeaders(baseUrl), ...init.headers },
    signal: opts.signal,
    dispatcher: qwenDispatcher(opts.dispatcher),
  } as RequestInit & { dispatcher?: unknown });
  harvestCookies(baseUrl, res);
  return res;
}'''.split('\n')

lines[start:end + 1] = new_block
print('hygiene block replaced')

# ---- 3. createChat: record block on persistent challenge, success otherwise --
old = [
    "      throw new QwenWebError('qwen WAF browser-verification challenge — retry shortly or route via a different egress IP', 503);",
]
new = [
    '      recordWafBlock(baseUrl);',
    "      throw new QwenWebError(`qwen WAF browser-verification challenge — ${wafRetryHint()}`, 503);",
]
replace_exact(old, new)

old = [
    '    const id = typeof j?.data === \'object\' ? j.data?.id : undefined;',
    '    if (!id) throw new QwenWebError(`qwen create-chat returned no chat id: ${bodyText.slice(0, 300)}`, 502);',
    '    return id;',
]
new = [
    '    const id = typeof j?.data === \'object\' ? j.data?.id : undefined;',
    '    if (!id) throw new QwenWebError(`qwen create-chat returned no chat id: ${bodyText.slice(0, 300)}`, 502);',
    '    recordWafSuccess();',
    '    return id;',
]
replace_exact(old, new)

# ---- 4. completions: record block / success ---------------------------------
old = [
    "    if (WAF_CHALLENGE.test(text)) throw new QwenWebError('qwen WAF browser-verification challenge — retry shortly or route via a different egress IP', 503);",
]
new = [
    '    if (WAF_CHALLENGE.test(text)) {',
    '      recordWafBlock(req.baseUrl);',
    '      throw new QwenWebError(`qwen WAF browser-verification challenge — ${wafRetryHint()}`, 503);',
    '    }',
]
replace_exact(old, new)

old = [
    '  const completionId = `chatcmpl-qwen-${chatId.slice(0, 8)}`;',
]
new = [
    '  recordWafSuccess();',
    '  const completionId = `chatcmpl-qwen-${chatId.slice(0, 8)}`;',
]
replace_exact(old, new)

# ---- 5. validate: record block / success ------------------------------------
old = [
    "    if (WAF_CHALLENGE.test(text)) return { ok: false, error: 'qwen WAF browser-verification challenge — retry shortly' };",
]
new = [
    '    if (WAF_CHALLENGE.test(text)) {',
    '      recordWafBlock(baseUrl);',
    "      return { ok: false, error: 'qwen WAF browser-verification challenge — retry shortly' };",
    '    }',
]
replace_exact(old, new)

old = [
    "    if (TOKEN_REJECTED.test(text)) return { ok: false, error: 'token rejected — reconnect the account' };",
    '    return { ok: true };',
]
new = [
    "    if (TOKEN_REJECTED.test(text)) return { ok: false, error: 'token rejected — reconnect the account' };",
    '    recordWafSuccess();',
    '    return { ok: true };',
]
replace_exact(old, new)

# ---- 6. sign-in: use the Chrome-shaped dispatcher ----------------------------
old = [
    '      r = await fetch(`${base}${path}`, { ...init, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout, dispatcher: opts.dispatcher } as RequestInit & {',
]
new = [
    '      r = await fetch(`${base}${path}`, { ...init, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout, dispatcher: qwenDispatcher(opts.dispatcher) } as RequestInit & {',
]
replace_exact(old, new)

io.open(qw, 'w', encoding='utf-8', newline='').write(NL.join(lines))
print('written, total lines:', len(lines))
