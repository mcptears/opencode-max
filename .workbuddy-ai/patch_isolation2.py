# Remaining test-file patches (backup.test.ts consts are unindented) + vitest config.
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


comment_new = '  // providers.json is isolated per test run via PROVIDERS_FILE (see setup.ts).'
const_old = "  const providersFile = path.join(projectRoot(), 'providers.json');"
const_new = "  const providersFile = process.env.PROVIDERS_FILE ?? path.join(projectRoot(), 'providers.json');"

patch(ROOT + r'\src\__tests__\backup.test.ts', [([
    "// providers.json has no env override — clean up anything the restore writes.",
    "const providersFile = path.join(projectRoot(), 'providers.json');",
], [
    '// providers.json is isolated per test run via PROVIDERS_FILE (see setup.ts).',
    "const providersFile = process.env.PROVIDERS_FILE ?? path.join(projectRoot(), 'providers.json');",
])])
patch(ROOT + r'\src\__tests__\deepseekLogin.test.ts', [(['  // providers.json has no env override — clean up anything the test writes.', const_old], [comment_new, const_new])])
patch(ROOT + r'\src\__tests__\qwenProviderAutoCreate.test.ts', [(['  // providers.json has no env override — clean up anything the test writes.', const_old], [comment_new, const_new])])
patch(ROOT + r'\src\__tests__\qwenSignin.test.ts', [(['  // providers.json has no env override — clean up anything the test writes.', const_old], [comment_new, const_new])])
patch(ROOT + r'\src\__tests__\zaiFlow.test.ts', [([const_old], [const_new])])

patch(ROOT + r'\vitest.config.ts', [([
    "    exclude: ['node_modules/**', 'dist/**'],",
    '    // Test files share the real providers.json (no env override exists for it).',
    "    // Parallel workers clobbered each other's file (4 tests failed in parallel,",
    '    // all pass solo) and the live config got deleted. Run files serially.',
    '    fileParallelism: false,',
    '  },',
], [
    "    exclude: ['node_modules/**', 'dist/**'],",
    '  },',
])])
