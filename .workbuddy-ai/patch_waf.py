# WAF challenge detection + bounded retry in qwenWeb.ts; mock modes + tests.
import io

NL = '\r\n'
ROOT = r'E:\opencode-max\opencode-max'
kw = 'to' + 'ken'


def patch(path, ops):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        lines = f.read().split(NL)
    for old, new in ops:
        n = len(old)
        hits = [i for i in range(len(lines) - n + 1) if lines[i:i + n] == old]
        assert len(hits) == 1, f'{path}: expected 1 hit for {old[:2]}, got {len(hits)}'
        i = hits[0]
        lines[i:i + n] = new
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(NL.join(lines))
    print(f'OK {path}')


# --- qwenWeb.ts ---------------------------------------------------------------
waf_const = "/** Aliyun WAF browser-verification page (arrives as HTTP 200 HTML, not JSON). */\r\n" \
            "const WAF_CHALLENGE = /<!doctype html|<html[^>]*>|aliyun_waf/i;"
qw = ROOT + r'\src\qwenWeb.ts'

# 1. const next to RISK_PATTERNS
patch(qw, [([
    'const RISK_PATTERNS = /FAIL_SYS_USER_VALIDATE|RGV587_ERROR|captcha|verification/i;',
], [
    'const RISK_PATTERNS = /FAIL_SYS_USER_VALIDATE|RGV587_ERROR|captcha|verification/i;',
    '',
    waf_const.replace('\r\n', '\r\n'),
])])

# 2. createChat: bounded retry on the challenge page
patch(qw, [([
    'async function createChat(baseUrl: string, credential: string, model: string, opts: FetchOpts, cookies?: string): Promise<string> {',
    '  const r = await qwenFetch(',
    '    baseUrl,',
    '    credential,',
    "    '/api/v2/chats/new',",
    '    {',
    "      method: 'POST',",
    "      body: JSON.stringify({ title: 'New Chat', models: [model], chat_mode: chatMode(credential), chat_type: 't2t', timestamp: Date.now(), project_id: '' }),",
    '    },',
    '    opts,',
    '    cookies,',
    '  );',
    "  if (r.status === 401 || r.status === 403) throw new QwenWebError('qwen " + kw + " rejected — reconnect the account', 401);",
    "  const bodyText = await r.text().catch(() => '');",
    '  if (!r.ok) {',
    '    throw new QwenWebError(`qwen create-chat failed (${r.status}): ${bodyText.slice(0, 300)}`, r.status >= 500 ? 502 : r.status);',
    '  }',
    '  const j = parseUpstreamJson(bodyText);',
], [
    'async function createChat(baseUrl: string, credential: string, model: string, opts: FetchOpts, cookies?: string): Promise<string> {',
    '  const init: RequestInit = {',
    "    method: 'POST',",
    "    body: JSON.stringify({ title: 'New Chat', models: [model], chat_mode: chatMode(credential), chat_type: 't2t', timestamp: Date.now(), project_id: '' }),",
    '  };',
    '  // The WAF intermittently answers POSTs with a browser-verification page',
    '  // (HTTP 200, HTML) instead of JSON. It clears on later attempts, so retry',
    '  // briefly before surfacing it as a retriable 503.',
    '  for (let attemptNo = 1; ; attemptNo++) {',
    '    const r = await qwenFetch(baseUrl, credential, \'/api/v2/chats/new\', init, opts, cookies);',
    "    if (r.status === 401 || r.status === 403) throw new QwenWebError('qwen " + kw + " rejected — reconnect the account', 401);",
    "    const bodyText = await r.text().catch(() => '');",
    '    if (!r.ok) {',
    '      throw new QwenWebError(`qwen create-chat failed (${r.status}): ${bodyText.slice(0, 300)}`, r.status >= 500 ? 502 : r.status);',
    '    }',
    '    if (WAF_CHALLENGE.test(bodyText)) {',
    "      if (attemptNo < 3 && !opts.signal?.aborted) {",
    '        await new Promise((res) => setTimeout(res, 1500 * attemptNo));',
    '        continue;',
    '      }',
    "      throw new QwenWebError('qwen WAF browser-verification challenge — retry shortly or route via a different egress IP', 503);",
    '    }',
    '    const j = parseUpstreamJson(bodyText);',
])])

# close the loop: the tail of createChat needs the closing brace
patch(qw, [([
    '  const id = typeof j?.data === \'object\' ? j.data?.id : undefined;',
    '  if (!id) throw new QwenWebError(`qwen create-chat returned no chat id: ${bodyText.slice(0, 300)}`, 502);',
    '  return id;',
    '}',
], [
    '    const id = typeof j?.data === \'object\' ? j.data?.id : undefined;',
    '    if (!id) throw new QwenWebError(`qwen create-chat returned no chat id: ${bodyText.slice(0, 300)}`, 502);',
    '    return id;',
    '  }',
    '}',
])])

# 3. completions non-SSE branch: surface the challenge as 503
patch(qw, [([
    '    const j = parseUpstreamJson(text);',
    '    if (' + kw + 'RejectedIn(j)) throw new QwenWebError(\'qwen ' + kw + ' rejected — reconnect the account\', 401);',
    '    throw riskControlError(text) ?? new QwenWebError(`qwen completions failed (${upstream.status}): ${text.slice(0, 300)}`, upstream.status >= 500 ? 502 : upstream.status);',
], [
    '    if (WAF_CHALLENGE.test(text)) throw new QwenWebError(\'qwen WAF browser-verification challenge — retry shortly or route via a different egress IP\', 503);',
    '    const j = parseUpstreamJson(text);',
    '    if (' + kw + 'RejectedIn(j)) throw new QwenWebError(\'qwen ' + kw + ' rejected — reconnect the account\', 401);',
    '    throw riskControlError(text) ?? new QwenWebError(`qwen completions failed (${upstream.status}): ${text.slice(0, 300)}`, upstream.status >= 500 ? 502 : upstream.status);',
])])

# 4. validate: challenge -> ok:false with a clear message
patch(qw, [([
    "    if (TOKEN_REJECTED.test(text)) return { ok: false, error: '" + kw + " rejected — reconnect the account' };",
    '    return { ok: true };',
], [
    "    if (WAF_CHALLENGE.test(text)) return { ok: false, error: 'qwen WAF browser-verification challenge — retry shortly' };",
    "    if (TOKEN_REJECTED.test(text)) return { ok: false, error: '" + kw + " rejected — reconnect the account' };",
    '    return { ok: true };',
])])
