# Add HTTP-200 + success:false coverage to qwenWeb.test.ts and
# 400 INVALID_CRED coverage to qwenSignin.test.ts. CRLF-aware, exact-match.
import io

NL = '\r\n'
BODY = '{"success":false,"request_id":"r","data":{"code":"unauthorized","details":"Token has expired, please log in again."}}'


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
    print(f'OK {path}: {len(lines)} lines')


# --- qwenWeb.test.ts ---------------------------------------------------------
t = r'E:\opencode-max\opencode-max\src\__tests__\qwenWeb.test.ts'
mode_line = [
    "let mode: 'ok' | 'risk' | 'unauth' | 'empty' = 'ok';",
]
mode_new = [
    "let mode: 'ok' | 'risk' | 'unauth' | 'empty' | 'expired' | 'expired-completions' = 'ok';",
]
expired_body_line = "          res.writeHead(200, { 'content-type': 'application/json' }).end('" + BODY.replace("'", "\\'") + "');"
get_old = [
    "      if (url.startsWith('/api/v2/chats/?') && req.method === 'GET') {",
    "        if (mode === 'unauth') {",
    "          res.writeHead(401).end('{}');",
    '          return;',
    '        }',
]
get_new = get_old[:4] + [
    "        if (mode === 'expired') {",
    expired_body_line,
    '          return;',
    '        }',
] + get_old[4:]
create_old = [
    "      if (url === '/api/v2/chats/new' && req.method === 'POST') {",
    '        lastCreateBody = JSON.parse(body);',
]
create_new = create_old + [
    "        if (mode === 'expired') {",
    expired_body_line,
    '          return;',
    '        }',
]
comp_old = [
    "        if (mode === 'unauth') {",
    "          res.writeHead(401).end('{}');",
    '          return;',
    '        }',
    "        if (mode === 'empty') {",
]
comp_new = [
    "        if (mode === 'unauth') {",
    "          res.writeHead(401).end('{}');",
    '          return;',
    '        }',
    "        if (mode === 'expired-completions') {",
    expired_body_line,
    '          return;',
    '        }',
    "        if (mode === 'empty') {",
]
tests_old = [
    "  it('rejects empty completions', async () => {",
]
tests_new = [
    "  it('treats HTTP 200 + success:false unauthorized as a dead credential (validate)', async () => {",
    "    mode = 'expired';",
    "    const r = await validateQwenCredential(base, 'stale');",
    '    expect(r.ok).toBe(false);',
    "    if (!r.ok) expect(r.error).toContain('reconnect');",
    "    mode = 'ok';",
    '  });',
    '',
    "  it('maps 200 + success:false create-chat to 401, not a retriable 502', async () => {",
    "    mode = 'expired';",
    '    try {',
    "      await qwenChatCompletion({ baseUrl: base, credential: 'stale', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });",
    '      expect.unreachable();',
    '    } catch (e) {',
    '      expect(e).toBeInstanceOf(QwenWebError);',
    '      expect((e as QwenWebError).status).toBe(401);',
    '    }',
    "    mode = 'ok';",
    '  });',
    '',
    "  it('maps 200 + success:false completions JSON to 401', async () => {",
    "    mode = 'expired-completions';",
    '    try {',
    "      await qwenChatCompletion({ baseUrl: base, credential: 'stale', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });",
    '      expect.unreachable();',
    '    } catch (e) {',
    '      expect((e as QwenWebError).status).toBe(401);',
    '    }',
    "    mode = 'ok';",
    '  });',
    '',
    "  it('rejects empty completions', async () => {",
]
patch(t, [ (mode_line, mode_new), (get_old, get_new), (create_old, create_new), (comp_old, comp_new), (tests_old, tests_new) ])

# --- qwenSignin.test.ts ------------------------------------------------------
s = r'E:\opencode-max\opencode-max\src\__tests__\qwenSignin.test.ts'
sm_old = [
    "let signinMode: 'cookie' | 'json-token' | 'v1-404' | 'bad-creds' = 'cookie';",
]
sm_new = [
    "let signinMode: 'cookie' | 'json-token' | 'v1-404' | 'bad-creds' | 'invalid-cred-400' = 'cookie';",
]
bad_old = [
    "        if (signinMode === 'bad-creds') {",
    "          res.writeHead(401, { 'content-type': 'application/json' }).end('{\"detail\":\"invalid credentials\"}');",
    '          return;',
    '        }',
]
bad_new = bad_old + [
    "        if (signinMode === 'invalid-cred-400') {",
    "          res.writeHead(400, { 'content-type': 'application/json' }).end('{\"detail\":{\"code\":\"INVALID_CRED\",\"details\":\"The email or password provided is incorrect. Please check for typos and try logging in again.\"}}');",
    '          return;',
    '        }',
]
st_old = [
    "  it('reports bad credentials clearly', async () => {",
]
st_new = [
    "  it('reports real-world 400 INVALID_CRED as bad credentials', async () => {",
    "    signinMode = 'invalid-cred-400';",
    "    const r = await qwenSignIn(mockBase, 'a@b.c', '0'.repeat(64));",
    "    expect(r).toEqual({ ok: false, error: 'email or password incorrect' });",
    "    signinMode = 'cookie';",
    '  });',
    '',
    "  it('reports bad credentials clearly', async () => {",
]
patch(s, [ (sm_old, sm_new), (bad_old, bad_new), (st_old, st_new) ])
