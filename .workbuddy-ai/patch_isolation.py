# Cookie fix in qwenWeb.ts + PROVIDERS_FILE isolation across setup/providers/tests,
# and revert the fileParallelism band-aid.
import io

NL = '\r\n'
ROOT = r'E:\opencode-max\opencode-max'


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


# --- qwenWeb.ts: Bearer-only for logged-in calls -----------------------------
kw = 'to' + 'ken'
patch(ROOT + r'\src\qwenWeb.ts', [
    # doc block
    ([
        " *   1. Auth: the account credential is either the `token` from",
        " *      chat.qwen.ai localStorage, or a Cookie header. It is sent with",
        " *      `source: web` — Bearer + `source: desktop` trips Qwen's",
        " *      FAIL_SYS_USER_VALIDATE risk control, so Cookie is preferred when the",
        " *      credential looks like one.",
    ], [
        " *   1. Auth: the account credential is the `token` from chat.qwen.ai",
        " *      localStorage, sent as `Authorization: Bearer` — never with the",
        " *      browser's cookies: stale anti-bot cookies (tfstk, ssxmod_itna) next",
        " *      to a valid Bearer trip baxia risk control, while the same request",
        " *      Bearer-only passes (the working qwen2API reference does the same).",
    ]),
    # logged-in branch: drop the Cookie attach
    ([
        "      'content-type': 'application/json',",
        '    };',
        "    if (cookies?.trim()) h['Cookie'] = cookies.trim();",
        '    return h;',
        '  }',
    ], [
        "      'content-type': 'application/json',",
        '    };',
        "    // No Cookie here: stale browser anti-bot cookies next to a valid Bearer",
        "    // trip baxia risk control (the reference client sends Bearer only).",
        '    return h;',
        '  }',
    ]),
])

# --- providers.ts: env override ----------------------------------------------
patch(ROOT + r'\src\providers.ts', [
    ([
        "export const PROVIDERS_FILE = path.join(projectRoot(), 'providers.json');",
    ], [
        "// Tests isolate providers.json via setup.ts; the app uses the real file.",
        'export const PROVIDERS_FILE = process.env.PROVIDERS_FILE ?? path.join(projectRoot(), ' + repr('providers.json').replace("'", "'") + ');',
    ]),
])

# --- setup.ts: set the override ----------------------------------------------
patch(ROOT + r'\src\__tests__\setup.ts', [
    ([
        "process.env.PROXIES_FILE = path.join(dir, 'proxies.json');",
    ], [
        "process.env.PROXIES_FILE = path.join(dir, 'proxies.json');",
        "// Isolate providers.json too — tests write/remove it and it holds the live config.",
        "process.env.PROVIDERS_FILE = path.join(dir, 'providers.json');",
    ]),
])

# --- test files: use the override --------------------------------------------
comment_old = '  // providers.json has no env override — clean up anything the test writes.'
comment_old_bk = '  // providers.json has no env override — clean up anything the restore writes.'
comment_new = '  // providers.json is isolated per test run via PROVIDERS_FILE (see setup.ts).'
const_old = "  const providersFile = path.join(projectRoot(), 'providers.json');"
const_new = "  const providersFile = process.env.PROVIDERS_FILE ?? path.join(projectRoot(), 'providers.json');"

patch(ROOT + r'\src\__tests__\backup.test.ts', [([comment_old_bk, const_old], [comment_new, const_new])])
patch(ROOT + r'\src\__tests__\deepseekLogin.test.ts', [([comment_old, const_old], [comment_new, const_new])])
patch(ROOT + r'\src\__tests__\qwenProviderAutoCreate.test.ts', [([comment_old, const_old], [comment_new, const_new])])
patch(ROOT + r'\src\__tests__\qwenSignin.test.ts', [([comment_old, const_old], [comment_new, const_new])])
patch(ROOT + r'\src\__tests__\zaiFlow.test.ts', [([const_old], [const_new])])

# --- vitest.config.ts: parallel again (root cause isolated) -------------------
patch(ROOT + r'\vitest.config.ts', [
    ([
        "    exclude: ['node_modules/**', 'dist/**'],",
        '    // Test files share the real providers.json (no env override exists for it).',
        "    // Parallel workers clobbered each other's file (4 tests failed in parallel,",
        '    // all pass solo) and the live config got deleted. Run files serially.',
        '    fileParallelism: false,',
        '  },',
    ], [
        "    exclude: ['node_modules/**', 'dist/**'],",
        '  },',
    ]),
])
