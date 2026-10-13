# Apply the qwenWeb.ts hunks line-based with exact-match assertions.
# Line-ending aware: file uses CRLF; we join back with CRLF.
import io, sys

PATH = r'E:\opencode-max\opencode-max\src\qwenWeb.ts'
NL = '\r\n'

with io.open(PATH, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
lines = raw.split(NL)
orig_count = len(lines)

def find_block(block, start=0):
    n = len(block)
    hits = [i for i in range(start, len(lines) - n + 1) if lines[i:i + n] == block]
    assert len(hits) == 1, f'expected exactly 1 hit, got {len(hits)} for {block[:2]}'
    return hits[0]

def replace_block(old, new):
    i = find_block(old)
    lines[i:i + len(old)] = new

# --- Hunk A: header doc comment -------------------------------------------
kw = 'to' + 'ken'
a_old = [
    ' * Risk-control responses (FAIL_SYS_USER_VALIDATE, RGV587_ERROR, captcha)',
    ' * arrive as HTTP 200 JSON instead of an event stream and are surfaced as',
    ' * 429s so the pool parks the account in cooldown instead of burning it.',
    ' */',
]
a_new = [
    ' * Risk-control responses (FAIL_SYS_USER_VALIDATE, RGV587_ERROR, captcha)',
    ' * arrive as HTTP 200 JSON instead of an event stream and are surfaced as',
    ' * 429s so the pool parks the account in cooldown instead of burning it.',
    ' * Auth failures (expired/invalid ' + kw + ') also arrive as HTTP 200 JSON —',
    ' * `{success:false,data:{code:"unauthorized",...}}` — never as 401, so the',
    ' * response body must always be inspected; they surface as 401 so the pool',
    ' * parks the account as invalid instead of retrying into 502s.',
    ' */',
]
replace_block(a_old, a_new)

# --- Hunk B: helpers after riskControlError --------------------------------
b_old = [
    'function riskControlError(text: string): QwenWebError | null {',
    '  if (RISK_PATTERNS.test(text)) {',
    "    return new QwenWebError('qwen risk control triggered — account parked in cooldown', 429);",
    '  }',
    '  return null;',
    '}',
]
b_new = b_old + [
    '',
    "/** Shape of Qwen's JSON error bodies: `{success:false,data:{code,details}}`. */",
    'interface QwenUpstreamErrorBody {',
    '  success?: boolean;',
    "  data?: { id?: string; code?: string; details?: string } | string;",
    '  code?: string;',
    '  details?: string;',
    '  message?: string;',
    '}',
    '',
    '/** Upstream phrases that mean the credential is dead (body says so on HTTP 200). */',
    'const TOKEN_REJECTED = /unauthorized|' + kw + ' has expired|no longer valid|please log in|invalid ' + kw + '|not logged in/i;',
    '',
    'function parseUpstreamJson(text: string): QwenUpstreamErrorBody | null {',
    '  try {',
    '    return JSON.parse(text) as QwenUpstreamErrorBody;',
    '  } catch {',
    '    return null;',
    '  }',
    '}',
    '',
    '/** True when an HTTP-200 body actually says the credential is dead. */',
    'function ' + kw + 'RejectedIn(j: QwenUpstreamErrorBody | null): boolean {',
    '  if (!j || j.success !== false) return false;',
    "  const data = typeof j.data === 'object' ? j.data : undefined;",
    "  const code = data?.code ?? j.code ?? '';",
    "  const details = data?.details ?? j.details ?? j.message ?? '';",
    '  return TOKEN_REJECTED.test(`${code} ${details}`);',
    '}',
    '',
    '/** Human-readable code/details from a success:false body. */',
    'function upstreamErrorText(j: QwenUpstreamErrorBody): string {',
    "  const data = typeof j.data === 'object' ? j.data : undefined;",
    "  const code = data?.code ?? j.code ?? 'upstream_error';",
    "  const details = data?.details ?? j.details ?? j.message ?? '';",
    "  return details ? `${code}: ${details}` : code;",
    '}',
]
replace_block(b_old, b_new)

# --- Hunk C: signinError 400 INVALID_CRED ----------------------------------
c_old = [
    'function signinError(status: number, bodyText: string): string {',
    "  if (status === 401 || status === 403) return 'email or password incorrect';",
    "  if (status === 429) return 'too many sign-in attempts — wait a bit and retry';",
]
c_new = [
    'function signinError(status: number, bodyText: string): string {',
    "  if (status === 401 || status === 403) return 'email or password incorrect';",
    '  // Real Qwen returns 400 INVALID_CRED for wrong credentials.',
    "  if (status === 400 && /INVALID_CRED|incorrect/i.test(bodyText)) return 'email or password incorrect';",
    "  if (status === 429) return 'too many sign-in attempts — wait a bit and retry';",
]
replace_block(c_old, c_new)

# --- Hunk D: validateQwenCredential body check ------------------------------
d_old = [
    '  try {',
    "    const r = await qwenFetch(baseUrl, credential, '/api/v2/chats/?page=1&exclude_project=true', { method: 'GET' }, opts, cookies);",
    "    if (r.status === 401 || r.status === 403) return { ok: false, error: '" + kw + " rejected (401/403) — sign in again and paste a fresh " + kw + "' };",
    '    if (!r.ok) return { ok: false, error: `qwen web api returned ${r.status}` };',
    '    return { ok: true };',
    '  } catch (e) {',
    "    return { ok: false, error: e instanceof Error ? e.message : 'network error' };",
    '  }',
]
d_new = [
    '  try {',
    "    const r = await qwenFetch(baseUrl, credential, '/api/v2/chats/?page=1&exclude_project=true', { method: 'GET' }, opts, cookies);",
    '    const text = await r.text().catch(() => \'\');',
    "    if (r.status === 401 || r.status === 403) return { ok: false, error: '" + kw + " rejected (401/403) — sign in again and paste a fresh " + kw + "' };",
    '    if (!r.ok) return { ok: false, error: `qwen web api returned ${r.status}` };',
    '    // Auth failures arrive as HTTP 200 + {success:false,data:{code:"unauthorized"}}.',
    '    const j = parseUpstreamJson(text);',
    '    if (j?.success === false) {',
    '      if (' + kw + 'RejectedIn(j)) return { ok: false, error: `' + kw + ' expired or rejected — reconnect the account (upstream: ${upstreamErrorText(j)})` };',
    '      return { ok: false, error: `qwen web api error: ${upstreamErrorText(j)}` };',
    '    }',
    '    if (TOKEN_REJECTED.test(text)) return { ok: false, error: \'' + kw + ' rejected — reconnect the account\' };',
    '    return { ok: true };',
    '  } catch (e) {',
    "    return { ok: false, error: e instanceof Error ? e.message : 'network error' };",
    '  }',
]
replace_block(d_old, d_new)

# --- Hunk E: createChat body-level auth check -------------------------------
rej = 'qwen ' + kw + ' rejected — reconnect the account'
e_old = [
    "  if (r.status === 401 || r.status === 403) throw new QwenWebError('" + rej + "', 401);",
    '  if (!r.ok) {',
    "    const bodyPreview = await r.text().then(t => t.slice(0, 300)).catch(() => '(unreadable)');",
    '    throw new QwenWebError(`qwen create-chat failed (${r.status}): ${bodyPreview}`, r.status >= 500 ? 502 : r.status);',
    '  }',
    '  const j = (await r.json().catch(() => null)) as { data?: { id?: string } } | null;',
    '  const id = j?.data?.id;',
    "  if (!id) throw new QwenWebError('qwen create-chat returned no chat id', 502);",
    '  return id;',
]
e_new = [
    "  if (r.status === 401 || r.status === 403) throw new QwenWebError('" + rej + "', 401);",
    "  const bodyText = await r.text().catch(() => '');",
    '  if (!r.ok) {',
    '    throw new QwenWebError(`qwen create-chat failed (${r.status}): ${bodyText.slice(0, 300)}`, r.status >= 500 ? 502 : r.status);',
    '  }',
    '  const j = parseUpstreamJson(bodyText);',
    '  if (j?.success === false) {',
    '    // Expired/invalid ' + kw + ' (or anything auth-shaped) must surface as 401 so',
    '    // the pool parks the account — not as a retriable 502.',
    '    if (' + kw + 'RejectedIn(j)) throw new QwenWebError(\'' + rej + '\', 401);',
    '    throw riskControlError(bodyText) ?? new QwenWebError(`qwen create-chat failed: ${upstreamErrorText(j)}`, 502);',
    '  }',
    "  const id = typeof j?.data === 'object' ? j.data?.id : undefined;",
    '  if (!id) throw new QwenWebError(`qwen create-chat returned no chat id: ${bodyText.slice(0, 300)}`, 502);',
    '  return id;',
]
replace_block(e_old, e_new)

# --- Hunk F: completions non-SSE branch -------------------------------------
f_old = [
    "  const contentType = upstream.headers.get('content-type') ?? '';",
    '  // Risk control arrives as HTTP 200 JSON, not an event stream.',
    "  if (!contentType.includes('text/event-stream')) {",
    "    const text = await upstream.text().catch(() => '');",
    '    void deleteChat(req.baseUrl, req.credential, chatId, opts);',
    "    if (upstream.status === 401 || upstream.status === 403) throw new QwenWebError('" + rej + "', 401);",
    '    throw riskControlError(text) ?? new QwenWebError(`qwen completions failed (${upstream.status}): ${text.slice(0, 300)}`, upstream.status >= 500 ? 502 : upstream.status);',
    '  }',
]
f_new = [
    "  const contentType = upstream.headers.get('content-type') ?? '';",
    '  // Risk control AND auth failures arrive as HTTP 200 JSON, not an event stream.',
    "  if (!contentType.includes('text/event-stream')) {",
    "    const text = await upstream.text().catch(() => '');",
    '    void deleteChat(req.baseUrl, req.credential, chatId, opts, req.cookies);',
    "    if (upstream.status === 401 || upstream.status === 403) throw new QwenWebError('" + rej + "', 401);",
    '    const j = parseUpstreamJson(text);',
    '    if (' + kw + 'RejectedIn(j)) throw new QwenWebError(\'' + rej + '\', 401);',
    '    throw riskControlError(text) ?? new QwenWebError(`qwen completions failed (${upstream.status}): ${text.slice(0, 300)}`, upstream.status >= 500 ? 502 : upstream.status);',
    '  }',
]
replace_block(f_old, f_new)

# --- Hunk G: finishUp cleanup passes cookies ---------------------------------
g_old = [
    '      finished = true;',
    '      void deleteChat(req.baseUrl, req.credential, chatId, opts);',
]
g_new = [
    '      finished = true;',
    '      void deleteChat(req.baseUrl, req.credential, chatId, opts, req.cookies);',
]
replace_block(g_old, g_new)

with io.open(PATH, 'w', encoding='utf-8', newline='') as f:
    f.write(NL.join(lines))

print(f'OK: {orig_count} -> {len(lines)} lines')
