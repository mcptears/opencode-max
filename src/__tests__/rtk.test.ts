import { describe, it, expect } from 'vitest';
import { detectRtkFilter, compressRtkText, compressRtkMessages, RTK_MIN_COMPRESS_BYTES } from '../rtk.js';
import { compressToolResults } from '../tokenSaver.js';

const pad = (s: string, n: number): string => Array.from({ length: n }, (_, i) => `${s} line ${i} padding xxxx`).join('\n');

describe('rtk auto-detect', () => {
  it('detects git diff', () => {
    const diff = 'diff --git a/f.ts b/f.ts\nindex 123..456\n--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n' + 'x'.repeat(600);
    expect(detectRtkFilter(diff)?.filterName).toBe('git-diff');
  });

  it('detects git log', () => {
    const log = 'commit abc1234def5678\nAuthor: Jane\nDate: today\n\n    did stuff\n' + 'x'.repeat(600);
    expect(detectRtkFilter(log)?.filterName).toBe('git-log');
  });

  it('detects git status', () => {
    const status = 'On branch main\nnothing to commit, working tree clean\n' + 'x'.repeat(600);
    expect(detectRtkFilter(status)?.filterName).toBe('git-status');
  });

  it('detects build output', () => {
    const build = 'npm ERR! code ENOENT\nnpm ERR! missing file\n' + 'Compiling foo\n'.repeat(40);
    expect(detectRtkFilter(build)?.filterName).toBe('build-output');
  });

  it('detects grep output', () => {
    const grep = 'src/a.ts:10:hello\nsrc/a.ts:20:world\nsrc/b.ts:5:hello\n' + 'x'.repeat(600);
    expect(detectRtkFilter(grep)?.filterName).toBe('grep');
  });

  it('detects find output', () => {
    const find = './src/a.ts\n./src/b.ts\n./lib/c.ts\n' + './x/y.ts\n'.repeat(30);
    expect(detectRtkFilter(find)?.filterName).toBe('find');
  });

  it('detects tree output', () => {
    const tree = '.\n├── src\n│   └── a.ts\n└── README.md\n' + 'x'.repeat(600);
    expect(detectRtkFilter(tree)?.filterName).toBe('tree');
  });

  it('detects ls output', () => {
    const ls =
      'total 16\ndrwxr-xr-x  4 u g 128 Jan  5 2026 src\n-rw-r--r--  1 u g 2048 Jan  5 2026 README.md\n-rw-r--r--  1 u g 1024 Jan  5 2026 main.ts\n' +
      'x'.repeat(600);
    expect(detectRtkFilter(ls)?.filterName).toBe('ls');
  });

  it('detects search lists', () => {
    const sl = "Result of search in 'src' (total 3 files):\n- src/a.ts\n- src/b.ts\n- lib/c.ts\n" + 'x'.repeat(600);
    expect(detectRtkFilter(sl)?.filterName).toBe('search-list');
  });

  it('detects line-numbered dumps', () => {
    const numbered = Array.from({ length: 300 }, (_, i) => `  ${i + 1}|content ${i}`).join('\n');
    expect(detectRtkFilter(numbered)?.filterName).toBe('read-numbered');
  });

  it('falls back to dedup-log for noisy duplicates', () => {
    const noisy = Array.from({ length: 40 }, (_, i) => `log line ${i % 5} repeated`).join('\n') + '\n' + 'x'.repeat(100);
    expect(detectRtkFilter(noisy)?.filterName).toBe('dedup-log');
  });

  it('returns null for small unstructured blobs', () => {
    expect(detectRtkFilter('just a short note')).toBeNull();
  });
});

describe('rtk filters', () => {
  it('git-diff truncates long hunks and summarizes per file', () => {
    const hunk = Array.from({ length: 300 }, (_, i) => `+added line ${i}`).join('\n');
    const diff = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,300 +1,300 @@\n${hunk}\n` + 'x'.repeat(100);
    const r = compressRtkText(diff);
    expect(r.filter).toBe('git-diff');
    expect(r.saved).toBeGreaterThan(0);
    expect(r.text).toContain('big.ts');
    expect(r.text).toContain('+300 -0');
    expect(r.text).toContain('lines truncated');
  });

  it('git-log keeps subjects, drops bodies', () => {
    const log =
      'commit abc1234def5678\nAuthor: Jane <j@x.io>\nDate:   Mon Jan 5\n\n    implement thing\n\n    long body paragraph that nobody needs\n    more body\n\n' +
      'commit def5678abc1234\nAuthor: Jane <j@x.io>\nDate:   Tue Jan 6\n\n    fix other\n';
    const r = compressRtkText(log + 'x'.repeat(600));
    expect(r.filter).toBe('git-log');
    expect(r.text).toContain('Subject: implement thing');
    expect(r.text).not.toContain('long body paragraph');
  });

  it('git-status compacts to counts', () => {
    const status = 'On branch main\n' + Array.from({ length: 30 }, (_, i) => ` M src/file${i}.ts`).join('\n') + '\n' + 'x'.repeat(100);
    const r = compressRtkText(status);
    expect(r.filter).toBe('git-status');
    expect(r.text).toContain('Modified: 30 files');
    expect(r.saved).toBeGreaterThan(0);
  });

  it('build-output keeps errors, drops progress noise', () => {
    const build = 'Compiling foo\n'.repeat(100) + 'Downloading bar\n'.repeat(50) + 'npm ERR! something broke\nBUILD FAILED\n';
    const r = compressRtkText(build);
    expect(r.filter).toBe('build-output');
    expect(r.text).toContain('npm ERR! something broke');
    expect(r.text).toContain('Compiled 100 packages');
    expect(r.text).not.toContain('Compiling foo\nCompiling foo');
  });

  it('grep groups matches by file', () => {
    const grep = Array.from({ length: 30 }, (_, i) => `src/a.ts:${i + 1}:match here`).join('\n') +
      '\n' + Array.from({ length: 5 }, (_, i) => `src/b.ts:${i + 1}:other`).join('\n');
    const r = compressRtkText(grep);
    expect(r.filter).toBe('grep');
    expect(r.text).toContain('[file] src/a.ts (30)');
    expect(r.text).toContain('+20');
  });

  it('find groups basenames by directory', () => {
    const find = Array.from({ length: 30 }, (_, i) => `./src/dir/file${i}.ts`).join('\n');
    const r = compressRtkText(find);
    expect(r.filter).toBe('find');
    expect(r.text).toContain('./src/dir/  (30)');
    expect(r.text).toContain('+20');
  });

  it('ls compacts to names+sizes and skips noise dirs', () => {
    const ls =
      'total 24\ndrwxr-xr-x  4 u g  128 Jan  5 2026 src\ndrwxr-xr-x  9 u g  288 Jan  5 2026 node_modules\n' +
      '-rw-r--r--  1 u g 204800 Jan  5 2026 bundle.js\n-rw-r--r--  1 u g   1024 Jan  5 2026 README.md\n' +
      'x'.repeat(600);
    const r = compressRtkText(ls);
    expect(r.filter).toBe('ls');
    expect(r.text).toContain('src/');
    expect(r.text).not.toContain('node_modules');
    expect(r.text).toContain('200.0K');
  });

  it('read-numbered keeps head and tail', () => {
    const numbered = Array.from({ length: 300 }, (_, i) => `  ${i + 1}|content ${i}`).join('\n');
    const r = compressRtkText(numbered);
    expect(r.filter).toBe('read-numbered');
    expect(r.text).toContain('  1|content 0');
    expect(r.text).toContain('300|content 299');
    expect(r.text).toContain('lines truncated');
    expect(r.saved).toBeGreaterThan(0);
  });

  it('dedup-log collapses duplicate runs', () => {
    const noisy = ('same line\n'.repeat(100) + 'other\n'.repeat(100)).repeat(3);
    const r = compressRtkText(noisy);
    expect(r.filter).toBe('dedup-log');
    expect(r.text).toContain('duplicate lines');
    expect(r.saved).toBeGreaterThan(1000);
  });

  it('never returns empty or grows the input', () => {
    const weird = 'commit abc123\n' + 'x'.repeat(RTK_MIN_COMPRESS_BYTES);
    const r = compressRtkText(weird);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text.length).toBeLessThanOrEqual(weird.length);
  });

  it('leaves small blobs untouched', () => {
    const r = compressRtkText('short');
    expect(r.saved).toBe(0);
    expect(r.text).toBe('short');
    expect(r.filter).toBeNull();
  });
});

describe('rtk message walking', () => {
  it('compresses OpenAI tool messages and skips error traces', () => {
    const diff = 'diff --git a/f.ts b/f.ts\n@@ -1 +1 @@\n' + '+x\n'.repeat(200);
    const body = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: diff },
        { role: 'tool', content: [{ type: 'text', text: diff }] },
      ],
    };
    const stats = compressRtkMessages(body);
    expect(stats.hits.length).toBe(2);
    expect(stats.hits[0].filter).toBe('git-diff');
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
  });

  it('preserves is_error tool results', () => {
    const big = 'err\n'.repeat(2000);
    const body = { messages: [{ role: 'user', content: [{ type: 'tool_result', is_error: true, content: big }] }] };
    const before = JSON.stringify(body);
    compressToolResults(body, 20000);
    expect(JSON.stringify(body)).toBe(before);
  });

  it('compresses via compressToolResults end to end', () => {
    const grep = Array.from({ length: 60 }, (_, i) => `src/a.ts:${i + 1}:found it`).join('\n');
    const body = { messages: [{ role: 'tool', content: grep }] };
    const saved = compressToolResults(body, 20000);
    expect(saved).toBeGreaterThan(0);
    const content = (body.messages[0] as { content: string }).content;
    expect(content).toContain('[file] src/a.ts (60)');
  });
});
