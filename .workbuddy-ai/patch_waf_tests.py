# Mock modes for WAF challenge + warm-chat reuse tests.
import io

NL = '\r\n'
p = r'E:\opencode-max\opencode-max\src\__tests__\qwenWeb.test.ts'


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


WAF_BODY = '<!doctype html><html><meta name="aliyun_waf_aa" content="x"></html>'

patch(p, [
    # mode union + counter
    ([
        "let mode: 'ok' | 'risk' | 'unauth' | 'empty' | 'expired' | 'expired-completions' = 'ok';",
    ], [
        "let mode: 'ok' | 'risk' | 'unauth' | 'empty' | 'expired' | 'expired-completions' | 'waf' | 'waf-hard' = 'ok';",
        'let createCalls = 0;',
    ]),
    # chats/new handler: counter + waf branches
    ([
        "      if (url === '/api/v2/chats/new' && req.method === 'POST') {",
        '        lastCreateBody = JSON.parse(body);',
    ], [
        "      if (url === '/api/v2/chats/new' && req.method === 'POST') {",
        '        lastCreateBody = JSON.parse(body);',
        '        createCalls++;',
        "        if (mode === 'waf' && createCalls <= 2) {",
        "          res.writeHead(200, { 'content-type': 'text/html' }).end('" + WAF_BODY + "');",
        '          return;',
        '        }',
        "        if (mode === 'waf-hard') {",
        "          res.writeHead(200, { 'content-type': 'text/html' }).end('" + WAF_BODY + "');",
        '          return;',
        '        }',
    ]),
    # new tests before the closing of the describe block (anchor: last test)
    ([
        "  it('rejects empty completions', async () => {",
    ], [
        "  it('reuses a warm chat across turns (chats/new is the challenged endpoint)', async () => {",
        "    mode = 'ok';",
        '    createCalls = 0;',
        '    for (let i = 0; i < 3; i++) {',
        "      const stream = await qwenChatCompletion({ baseUrl: base, credential: 'tok', model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }], stream: false });",
        '      const j = JSON.parse(await readAll(stream));',
        "      expect(j.object).toBe('chat.completion');",
        '    }',
        '    expect(createCalls).toBe(1);',
        '    // a different credential gets its own warm chat',
        "    await qwenChatCompletion({ baseUrl: base, credential: 'tok2', model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }], stream: false });",
        '    expect(createCalls).toBe(2);',
        '  });',
        '',
        "  it('retries through WAF challenge pages and succeeds', async () => {",
        "    mode = 'waf';",
        '    createCalls = 0;',
        "    const stream = await qwenChatCompletion({ baseUrl: base, credential: 'waf', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: false });",
        '    const j = JSON.parse(await readAll(stream));',
        "    expect(j.object).toBe('chat.completion');",
        '    expect(createCalls).toBe(3);',
        "    mode = 'ok';",
        '  });',
        '',
        "  it('surfaces a 503 when the WAF challenge persists', async () => {",
        "    mode = 'waf-hard';",
        '    try {',
        "      await qwenChatCompletion({ baseUrl: base, credential: 'waf2', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });",
        '      expect.unreachable();',
        '    } catch (e) {',
        '      expect(e).toBeInstanceOf(QwenWebError);',
        '      expect((e as QwenWebError).status).toBe(503);',
        '    }',
        "    mode = 'ok';",
        '  });',
        '',
        "  it('rejects empty completions', async () => {",
    ]),
])
