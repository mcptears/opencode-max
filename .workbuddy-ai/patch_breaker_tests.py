# Breaker tests + test controls in qwenWeb.test.ts.
import io

NL = '\r\n'
p = r'E:\opencode-max\opencode-max\src\__tests__\qwenWeb.test.ts'
lines = io.open(p, encoding='utf-8', newline='').read().split(NL)


def replace_exact(old, new):
    n = len(old)
    hits = [i for i in range(len(lines) - n + 1) if lines[i:i + n] == old]
    assert len(hits) == 1, f'expected 1, got {len(hits)}: {old[0][:70]}'
    i = hits[0]
    lines[i:i + n] = new
    print('ok at', i + 1)


# imports
replace_exact([
    "import { describe, it, expect, beforeAll, afterAll } from 'vitest';",
], [
    "import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';",
])
replace_exact([
    '  qwenChatCompletion,',
    '  validateQwenCredential,',
    '  QwenWebError,',
    "} from '../qwenWeb.js';",
], [
    '  qwenChatCompletion,',
    '  validateQwenCredential,',
    '  QwenWebError,',
    '  __wafTestControls,',
    "} from '../qwenWeb.js';",
])

# beforeEach after the mode variable declaration
replace_exact([
    'let createCalls = 0;',
], [
    'let createCalls = 0;',
    '',
    'beforeEach(() => {',
    '  // Shrink the WAF breaker timing and reset its module state between tests.',
    '  __wafTestControls(150, 400);',
    "  mode = 'ok';",
    '  createCalls = 0;',
    '});',
])

# breaker tests before 'rejects empty completions'
replace_exact([
    "  it('rejects empty completions', async () => {",
], [
    "  it('fails fast with a retry hint once the WAF breaker is open', async () => {",
    "    mode = 'waf-hard';",
    '    try {',
    "      await qwenChatCompletion({ baseUrl: base, credential: 'waf-fast', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });",
    '      expect.unreachable();',
    '    } catch (e) {',
    '      expect((e as QwenWebError).status).toBe(503);',
    '    }',
    '    const hitsAfterOpen = createCalls;',
    '    try {',
    "      await qwenChatCompletion({ baseUrl: base, credential: 'waf-fast', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });",
    '      expect.unreachable();',
    '    } catch (e) {',
    '      expect((e as QwenWebError).status).toBe(503);',
    "      expect((e as QwenWebError).message).toContain('retry in');",
    '    }',
    '    // The fail-fast path must not touch the upstream at all.',
    '    expect(createCalls).toBe(hitsAfterOpen);',
    "    mode = 'ok';",
    '  });',
    '',
    "  it('closes the breaker after the background probe sees the block lift', async () => {",
    "    mode = 'waf-hard';",
    '    try {',
    "      await qwenChatCompletion({ baseUrl: base, credential: 'waf-rec', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });",
    '      expect.unreachable();',
    '    } catch (e) {',
    '      expect((e as QwenWebError).status).toBe(503);',
    '    }',
    "    mode = 'ok';",
    '    let recovered = false;',
    '    for (let i = 0; i < 10 && !recovered; i++) {',
    '      await new Promise((r) => setTimeout(r, 300));',
    '      try {',
    "        const stream = await qwenChatCompletion({ baseUrl: base, credential: 'waf-rec', model: 'm', messages: [{ role: 'user', content: 'x' }], stream: false });",
    '        const j = JSON.parse(await readAll(stream));',
    "        recovered = j.object === 'chat.completion';",
    '      } catch {',
    '        /* still gated or probing — retry */',
    '      }',
    '    }',
    '    expect(recovered).toBe(true);',
    '  });',
    '',
    "  it('rejects empty completions', async () => {",
])

io.open(p, 'w', encoding='utf-8', newline='').write(NL.join(lines))
print('test file updated')
