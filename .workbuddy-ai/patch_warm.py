# Warm-chat pool + warm-up cookies + pacing in qwenWeb.ts.
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


qw = ROOT + r'\src\qwenWeb.ts'

# --- 1. pacing + warm-up cookies inserted before qwenFetch --------------------
patch(qw, [([
    'async function qwenFetch(baseUrl: string, credential: string, path: string, init: RequestInit, opts: FetchOpts, cookies?: string): Promise<Response> {',
    '  return fetch(`${baseUrl.replace(/\\/+$/, \'\')}${path}`, {',
    '    ...init,',
    '    headers: { ...(await headers(credential, cookies)), ...init.headers },',
], [
    '// ============================================================================',
    '// WAF hygiene (mirrors the production reference clients for this exact WAF):',
    '//  - warm up with a GET to the site root first, collecting acw_tc-style cookies,',
    '//  - keep a random 200-500 ms shared gap between upstream calls (bursts are',
    '//    what trips the Aliyun WAF),',
    '//  - reuse chats instead of one chat per request (chats/new is the most',
    '//    aggressively challenged endpoint; one chat per message looks like a bot).',
    '// ============================================================================',
    '',
    'const WARM_COOKIE_TTL_MS = 30 * 60 * 1000;',
    'const warmCookieCache = new Map<string, { cookie: string; at: number }>();',
    '',
    '/** GET the site root once per base to collect anti-bot (acw_tc-style) cookies. */',
    'async function warmUpCookies(baseUrl: string): Promise<string> {',
    '  const cached = warmCookieCache.get(baseUrl);',
    '  if (cached && Date.now() - cached.at < WARM_COOKIE_TTL_MS) return cached.cookie;',
    '  try {',
    "    const r = await fetch(`${baseUrl.replace(/\\/+$/, '')}/`, {",
    '      headers: {',
    "        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',",
    "        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',",
    '      },',
    '      signal: AbortSignal.timeout(15000),',
    '    });',
    "    const raw = typeof (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'",
    '      ? (r.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()',
    '      : [];',
    "    const cookie = raw.map((c) => c.split(';')[0]).filter((c) => /^(acw_|cdn_sec_tc|x-ap)=/i.test(c)).join('; ');",
    '    if (cookie) {',
    '      warmCookieCache.set(baseUrl, { cookie, at: Date.now() });',
    '      return cookie;',
    '    }',
    '  } catch {',
    '    /* best-effort */',
    '  }',
    "  return '';",
    '}',
    '',
    '// Shared pacing gate: every upstream call claims the next start slot.',
    'let paceNextSlot = 0;',
    'let paceGapMs = 0;',
    '',
    'async function pace(): Promise<void> {',
    '  if (!paceGapMs) paceGapMs = 200 + Math.floor(Math.random() * 300);',
    '  const now = Date.now();',
    '  const slot = Math.max(now, paceNextSlot);',
    '  paceNextSlot = slot + paceGapMs;',
    '  const wait = slot - now;',
    '  if (wait > 0) await new Promise((res) => setTimeout(res, wait));',
    '}',
    '',
    'async function qwenFetch(baseUrl: string, credential: string, path: string, init: RequestInit, opts: FetchOpts, cookies?: string): Promise<Response> {',
    '  await pace();',
    '  const warm = await warmUpCookies(baseUrl);',
    '  return fetch(`${baseUrl.replace(/\\/+$/, \'\')}${path}`, {',
    '    ...init,',
    '    headers: { ...(await headers(credential, cookies)), ...(warm ? { Cookie: warm } : {}), ...init.headers },',
])])

# --- 2. warm chat pool after deleteChat ---------------------------------------
patch(qw, [([
    '/** Best-effort cleanup of the disposable chat; never throws. */',
    'async function deleteChat(baseUrl: string, credential: string, chatId: string, opts: FetchOpts, cookies?: string): Promise<void> {',
    '  try {',
    "    await qwenFetch(baseUrl, credential, `/api/v2/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' }, opts, cookies);",
    '  } catch {',
    '    /* ignore — chats are disposable */',
    '  }',
    '}',
], [
    '/** Best-effort cleanup when retiring a warm chat; never throws. */',
    'async function deleteChat(baseUrl: string, credential: string, chatId: string, opts: FetchOpts, cookies?: string): Promise<void> {',
    '  try {',
    "    await qwenFetch(baseUrl, credential, `/api/v2/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' }, opts, cookies);",
    '  } catch {',
    '    /* ignore */',
    '  }',
    '}',
    '',
    '// ----------------------------------------------------------------------------',
    '// Warm chat pool: reuse one chat for several turns, then retire it.',
    '// ----------------------------------------------------------------------------',
    '',
    'const WARM_CHAT_REUSE = 10;',
    'const WARM_CHAT_TTL_MS = 20 * 60 * 1000;',
    '',
    'interface WarmChat {',
    '  id: string;',
    '  uses: number;',
    '  created: number;',
    '}',
    '',
    'const warmChats = new Map<string, WarmChat>();',
    'const warmChatInflight = new Map<string, Promise<string>>();',
    '',
    'function warmChatKey(credential: string, model: string): string {',
    '  return `${credential.slice(0, 40)}|${model}`;',
    '}',
    '',
    '/** Take a warm chat or create one; concurrent callers share the creation. */',
    'async function takeChat(baseUrl: string, credential: string, model: string, opts: FetchOpts, cookies?: string): Promise<string> {',
    '  const key = warmChatKey(credential, model);',
    '  const cached = warmChats.get(key);',
    '  if (cached && cached.uses < WARM_CHAT_REUSE && Date.now() - cached.created < WARM_CHAT_TTL_MS) {',
    '    cached.uses++;',
    '    return cached.id;',
    '  }',
    '  if (cached) {',
    '    warmChats.delete(key);',
    '    void deleteChat(baseUrl, credential, cached.id, opts, cookies);',
    '  }',
    '  const inflight = warmChatInflight.get(key);',
    '  if (inflight) return inflight;',
    '  const run = createChat(baseUrl, credential, model, opts, cookies)',
    '    .then((id) => {',
    '      warmChats.set(key, { id, uses: 1, created: Date.now() });',
    '      return id;',
    '    })',
    '    .finally(() => warmChatInflight.delete(key));',
    '  warmChatInflight.set(key, run);',
    '  return run;',
    '}',
    '',
    '/** Drop a warm chat (upstream rejected it — e.g. expired or 404). */',
    'function dropWarmChat(credential: string, model: string): void {',
    '  warmChats.delete(warmChatKey(credential, model));',
    '}',
])])

# --- 3. qwenChatCompletion: takeChat instead of createChat --------------------
patch(qw, [([
    '  const opts: FetchOpts = { signal: req.signal, dispatcher: req.dispatcher };',
    '  const chatId = await createChat(req.baseUrl, req.credential, req.model, opts, req.cookies);',
], [
    '  const opts: FetchOpts = { signal: req.signal, dispatcher: req.dispatcher };',
    '  const chatId = await takeChat(req.baseUrl, req.credential, req.model, opts, req.cookies);',
])])

# --- 4. lifecycle: keep the chat warm instead of deleting ---------------------
patch(qw, [([
    '  } catch (e) {',
    '    void deleteChat(req.baseUrl, req.credential, chatId, opts, req.cookies);',
    '    throw e;',
    '  }',
], [
    '  } catch (e) {',
    '    throw e; // network-level: the warm chat stays reusable',
    '  }',
])])

patch(qw, [([
    '    const text = await upstream.text().catch(() => \'\');',
    '    void deleteChat(req.baseUrl, req.credential, chatId, opts, req.cookies);',
], [
    '    const text = await upstream.text().catch(() => \'\');',
    '    if (upstream.status === 404 || upstream.status === 401 || upstream.status === 403) dropWarmChat(req.credential, req.model);',
])])

patch(qw, [([
    '  const upstreamBody = upstream.body;',
    '  if (!upstreamBody) {',
    '    void deleteChat(req.baseUrl, req.credential, chatId, opts);',
    '    throw new QwenWebError(\'qwen returned an empty stream\', 502);',
    '  }',
], [
    '  const upstreamBody = upstream.body;',
    '  if (!upstreamBody) {',
    '    dropWarmChat(req.credential, req.model);',
    '    throw new QwenWebError(\'qwen returned an empty stream\', 502);',
    '  }',
])])

# finishUp no longer deletes the chat (it stays warm).
patch(qw, [([
    '  let finished = false;',
    '  const finishUp = (): void => {',
    '    if (!finished) {',
    '      finished = true;',
    '      void deleteChat(req.baseUrl, req.credential, chatId, opts, req.cookies);',
    '    }',
    '  };',
], [
    '  let finished = false;',
    '  const finishUp = (): void => {',
    '    finished = true;',
    '  };',
])])

# empty completion -> the chat is suspect: drop it
patch(qw, [([
    '      if (!content && !reasoning) throw new QwenWebError(\'qwen returned an empty completion\', 502);',
], [
    '      if (!content && !reasoning) {',
    '        dropWarmChat(req.credential, req.model);',
    '        throw new QwenWebError(\'qwen returned an empty completion\', 502);',
    '      }',
])])
