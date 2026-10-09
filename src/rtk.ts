/**
 * RTK-style token saver: content-aware compression for tool_result payloads.
 *
 * Agentic coding loops routinely stuff tens of KB of tool output (git diffs,
 * grep hits, build logs, ls dumps…) into prompts. Instead of dumb truncation,
 * RTK peeks at each blob, detects what *kind* of output it is, and applies a
 * filter that keeps the signal while dropping the noise — the same answer for
 * far fewer tokens.
 *
 * Safety rules (never break a request):
 * - Blobs under MIN_COMPRESS_BYTES pass through untouched.
 * - A filter that throws, returns empty, or grows the input is discarded and
 *   the original text is kept.
 */
export type RtkFilter = ((text: string) => string) & { filterName: string };

export const RTK_MIN_COMPRESS_BYTES = 500;
const DETECT_WINDOW = 1024;
const HUNK_MAX_LINES = 100;
const DIFF_MAX_LINES = 500;
const LOG_MAX_LINES = 200;
const DEDUP_LINE_MAX = 2000;
const GREP_PER_FILE_MAX = 10;
const FIND_PER_DIR_MAX = 10;
const FIND_TOTAL_DIR_MAX = 20;
const STATUS_MAX_FILES = 10;
const TREE_MAX_LINES = 200;
const TRUNCATE_HEAD = 120;
const TRUNCATE_TAIL = 60;
const TRUNCATE_MIN_LINES = 250;
const READ_NUMBERED_MIN_RATIO = 0.7;
const NOISE_DIRS = new Set([
  'node_modules', '.git', 'target', '__pycache__', '.next', 'dist', 'build',
  '.cache', '.turbo', '.vercel', '.pytest_cache', '.mypy_cache', '.tox',
  '.venv', 'venv', 'coverage', '.nyc_output', '.DS_Store', 'Thumbs.db',
  '.idea', '.vscode', '.vs',
]);

function named(name: string, fn: (text: string) => string): RtkFilter {
  const f = fn as RtkFilter;
  f.filterName = name;
  return f;
}

/** git diff: per-hunk truncation + per-file +/- summary. */
export const gitDiffFilter = named('git-diff', (diff: string): string => {
  const out: string[] = [];
  let file = '';
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let shown = 0;
  let skipped = 0;
  let truncated = false;

  const flushSkipped = (): void => {
    if (skipped > 0) {
      out.push(`  ... (${skipped} lines truncated)`);
      truncated = true;
      skipped = 0;
    }
  };
  const flushFile = (): void => {
    if (file && (added > 0 || removed > 0)) out.push(`  +${added} -${removed}`);
  };

  outer: for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      flushSkipped();
      flushFile();
      const parts = line.split(' b/');
      file = parts.length > 1 ? parts.slice(1).join(' b/') : 'unknown';
      out.push(`\n${file}`);
      added = 0;
      removed = 0;
      inHunk = false;
      shown = 0;
    } else if (line.startsWith('@@')) {
      flushSkipped();
      inHunk = true;
      shown = 0;
      out.push(`  ${line}`);
    } else if (inHunk) {
      if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) {
        if (line.startsWith('+')) added++;
        else removed++;
        if (shown < HUNK_MAX_LINES) {
          out.push(`  ${line}`);
          shown++;
        } else {
          skipped++;
        }
      } else if (shown < HUNK_MAX_LINES && shown > 0 && !line.startsWith('\\')) {
        out.push(`  ${line}`);
        shown++;
      }
    }
    if (out.length >= DIFF_MAX_LINES) {
      out.push('\n... (more changes truncated)');
      truncated = true;
      break outer;
    }
  }
  flushSkipped();
  flushFile();
  if (truncated) out.push('[use git diff for the full output]');
  return out.join('\n');
});

/** git log: keep commit headers, author/date, subject; drop bodies and embedded diffs. */
export const gitLogFilter = named('git-log', (text: string): string => {
  const out: string[] = [];
  let skipped = 0;
  let inCommit = false;
  let subjectSeen = false;
  const push = (l: string): void => {
    if (out.length < LOG_MAX_LINES) out.push(l);
    else skipped++;
  };
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (/^commit [0-9a-f]{7,40}$/i.test(trimmed) || /^[*|/\\ ]+commit [0-9a-f]{7,40}/i.test(trimmed)) {
      inCommit = true;
      subjectSeen = false;
      push(raw);
      continue;
    }
    if (inCommit) {
      if (/^[*|/\\ ]*(Author|Date):/i.test(trimmed)) {
        push(trimmed);
        continue;
      }
      if (trimmed === '') continue;
      if (!subjectSeen && /^[*|/\\ ]*    \S/.test(raw)) {
        push('  Subject: ' + trimmed);
        subjectSeen = true;
        continue;
      }
      if (/^\d+ files? changed/.test(trimmed)) {
        push('  ' + trimmed);
        continue;
      }
      if (/^diff --git /.test(trimmed)) {
        push('  ... diff body omitted');
        continue;
      }
      continue;
    }
    const graph = trimmed.match(/^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i);
    if (graph) {
      push(graph[1]);
      continue;
    }
    if (/^[0-9a-f]{7,40}\s+/.test(trimmed)) {
      push(trimmed);
      continue;
    }
    if (/^[*|/\\ ]+$/.test(trimmed)) continue;
    push(trimmed);
  }
  if (skipped > 0) out.push(`... (${skipped} more lines)`);
  const result = out.join('\n');
  return result || text;
});

/** git status: parse porcelain/long form into a compact summary. */
export const gitStatusFilter = named('git-status', (text: string): string => {
  let branch = '';
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  let conflicts = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const longBranch = /^On branch (\S+)/.exec(raw);
    if (longBranch) {
      branch = longBranch[1];
      continue;
    }
    if (raw.startsWith('##')) {
      branch = raw.replace(/^##\s*/, '');
      continue;
    }
    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const x = raw[0];
      const y = raw[1];
      const file = raw.slice(3);
      if (raw.slice(0, 2) === '??') {
        untracked.push(file);
        continue;
      }
      if ('MADRC'.includes(x)) staged.push(file);
      else if (x === 'U') conflicts++;
      if (y === 'M' || y === 'D') modified.push(file);
      continue;
    }
    const long = /^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/.exec(raw);
    if (long) {
      if (long[1] === 'both modified') conflicts++;
      else if (long[1] === 'modified' || long[1] === 'deleted') modified.push(long[2].trim());
      else staged.push(long[2].trim());
    }
  }
  const list = (files: string[]): string =>
    files
      .slice(0, STATUS_MAX_FILES)
      .map((f) => `   ${f}`)
      .join('\n') + (files.length > STATUS_MAX_FILES ? `\n   ... +${files.length - STATUS_MAX_FILES} more` : '');
  let out = '';
  if (branch) out += `* ${branch}\n`;
  if (staged.length > 0) out += `+ Staged: ${staged.length} files\n${list(staged)}\n`;
  if (modified.length > 0) out += `~ Modified: ${modified.length} files\n${list(modified)}\n`;
  if (untracked.length > 0) out += `? Untracked: ${untracked.length} files\n${list(untracked)}\n`;
  if (conflicts > 0) out += `conflicts: ${conflicts} files\n`;
  if (!out) out = 'clean — nothing to commit\n';
  return out.replace(/\n+$/, '');
});

/** Build output: keep errors, warnings, summary; drop progress/download noise. */
export const buildOutputFilter = named('build-output', (text: string): string => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const deprecations: string[] = [];
  let summary: string | null = null;
  let compiling = 0;
  let downloading = 0;
  let inCargoError = false;
  const cargoCont = /^\s*(-->|\||\d+\s*\||=)/;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (inCargoError) {
      if (!t) {
        inCargoError = false;
        continue;
      }
      if (cargoCont.test(line)) {
        errors.push(line);
        continue;
      }
      inCargoError = false;
    }
    if (!t) continue;
    if (/^npm (ERR!|error)/i.test(t) || /^yarn error/i.test(t)) {
      errors.push(line);
      continue;
    }
    if (/^npm warn deprecated/i.test(t)) {
      deprecations.push(line);
      continue;
    }
    if (/^npm warn/i.test(t) || /^yarn warn/i.test(t) || /^\[WARNING\]/i.test(t)) {
      warnings.push(line);
      continue;
    }
    if (/^error(\[|:)/i.test(t) || /^warning(\[|:)/i.test(t) || t.startsWith('error -->') || t.startsWith('warning -->')) {
      (t.toLowerCase().startsWith('error') ? errors : warnings).push(line);
      inCargoError = true;
      continue;
    }
    if (/^ERROR:/i.test(t) || /^\[ERROR\]/i.test(t) || /^BUILD FAILED/i.test(t)) {
      errors.push(line);
      continue;
    }
    if (/^\s*Compiling\s+\S+/i.test(t)) {
      compiling++;
      continue;
    }
    if (/^\s*Downloading\s+\S+/i.test(t) || /^Fetching\s+/i.test(t)) {
      downloading++;
      continue;
    }
    if (
      /^(added|removed|changed|audited|installed)\s+\d+\s+package/i.test(t) ||
      /^\s*Finished\s+/i.test(t) ||
      /^BUILD SUCCESS/i.test(t) ||
      /^\d+\s+(vulnerabilities|packages?|warnings?|errors?)/i.test(t) ||
      /^Successfully (installed|built)/i.test(t)
    ) {
      summary = summary ? `${summary}\n${line}` : line;
    }
  }
  let out = '';
  for (const d of deprecations.slice(0, 3)) out += `${d}\n`;
  if (deprecations.length > 3) out += `... +${deprecations.length - 3} more deprecated packages\n`;
  if (compiling > 0) out += `Compiled ${compiling} packages\n`;
  if (downloading > 0) out += `Downloaded ${downloading} packages\n`;
  for (const e of errors) out += `${e}\n`;
  for (const w of warnings.slice(0, 5)) out += `${w}\n`;
  if (warnings.length > 5) out += `... +${warnings.length - 5} more warnings\n`;
  if (summary) out += `${summary}\n`;
  const result = out.replace(/\n+$/, '');
  return result || text;
});

/* ---- remaining filters, appended to src/rtk.ts ---- */

/** grep output (file:line:content): group by file, cap matches per file. */
export const grepFilter: RtkFilter = Object.assign(
  (input: string): string => {
    const byFile = new Map<string, [string, string][]>();
    let total = 0;
    for (const line of input.split('\n')) {
      const first = line.indexOf(':');
      if (first === -1) continue;
      const second = line.indexOf(':', first + 1);
      if (second === -1) continue;
      const file = line.slice(0, first);
      const lineNo = line.slice(first + 1, second);
      const content = line.slice(second + 1);
      if (!/^\d+$/.test(lineNo)) continue;
      total++;
      const list = byFile.get(file) ?? [];
      list.push([lineNo, content]);
      byFile.set(file, list);
    }
    if (total === 0) return input;
    const files = [...byFile.keys()].sort();
    let out = `${total} matches in ${files.length}F:\n\n`;
    for (const file of files) {
      const matches = byFile.get(file)!;
      out += `[file] ${file} (${matches.length}):\n`;
      for (const [lineNo, content] of matches.slice(0, GREP_PER_FILE_MAX)) {
        out += `  ${lineNo.padStart(4)}: ${content.trim()}\n`;
      }
      if (matches.length > GREP_PER_FILE_MAX) out += `  +${matches.length - GREP_PER_FILE_MAX}\n`;
      out += '\n';
    }
    return out;
  },
  { filterName: 'grep' },
);

/** find output (bare paths): group basenames by directory. */
export const findFilter: RtkFilter = Object.assign(
  (input: string): string => {
    const lines = input.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return input;
    const byDir = new Map<string, string[]>();
    for (const p of lines) {
      const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      const dir = lastSep === -1 ? '.' : p.slice(0, lastSep) || '/';
      const base = lastSep === -1 ? p : p.slice(lastSep + 1);
      const list = byDir.get(dir) ?? [];
      list.push(base);
      byDir.set(dir, list);
    }
    const dirs = [...byDir.keys()].sort();
    let out = `${lines.length} files in ${dirs.length} dirs:\n\n`;
    for (const dir of dirs.slice(0, FIND_TOTAL_DIR_MAX)) {
      const files = byDir.get(dir)!;
      out += `${dir.replace(/\\/g, '/')}/  (${files.length})\n`;
      for (const f of files.slice(0, FIND_PER_DIR_MAX)) out += `  ${f}\n`;
      if (files.length > FIND_PER_DIR_MAX) out += `  +${files.length - FIND_PER_DIR_MAX}\n`;
    }
    if (dirs.length > FIND_TOTAL_DIR_MAX) out += `\n+${dirs.length - FIND_TOTAL_DIR_MAX} more dirs\n`;
    return out;
  },
  { filterName: 'find' },
);

/** ls -la output: compact to dirs + files with sizes, skip noise dirs. */
export const lsFilter: RtkFilter = Object.assign(
  (input: string): string => {
    const dateRe = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;
    const human = (b: number): string =>
      b >= 1048576 ? `${(b / 1048576).toFixed(1)}M` : b >= 1024 ? `${(b / 1024).toFixed(1)}K` : `${b}B`;
    const dirs: string[] = [];
    const files: [string, string][] = [];
    const byExt = new Map<string, number>();
    for (const line of input.split('\n')) {
      if (line.startsWith('total ') || !line) continue;
      const m = dateRe.exec(line);
      if (!m) continue;
      const name = line.slice(m.index + m[0].length);
      const before = line.slice(0, m.index).split(/\s+/).filter(Boolean);
      if (before.length < 4 || name === '.' || name === '..' || NOISE_DIRS.has(name)) continue;
      const type = before[0].charAt(0);
      let size = 0;
      for (let i = before.length - 1; i >= 0; i--) {
        if (/^\d+$/.test(before[i])) {
          size = Number(before[i]);
          break;
        }
      }
      if (type === 'd') dirs.push(name);
      else if (type === '-' || type === 'l') {
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 ? name.slice(dot) : 'no ext';
        byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
        files.push([name, human(size)]);
      }
    }
    if (dirs.length === 0 && files.length === 0) return input;
    let out = '';
    for (const d of dirs) out += `${d}/\n`;
    for (const [name, size] of files) out += `${name}  ${size}\n`;
    out += `\nSummary: ${files.length} files, ${dirs.length} dirs`;
    if (byExt.size > 0) {
      const top = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      out += ` (${top.map(([e, c]) => `${c} ${e}`).join(', ')}${byExt.size > 5 ? `, +${byExt.size - 5} more` : ''})`;
    }
    return out;
  },
  { filterName: 'ls' },
);

/** tree output: drop the summary line and cap length. */
export const treeFilter: RtkFilter = Object.assign(
  (input: string): string => {
    const kept: string[] = [];
    for (const line of input.split('\n')) {
      if (line.includes('director') && line.includes('file')) continue;
      if (line.trim() === '' && kept.length === 0) continue;
      kept.push(line);
    }
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    if (kept.length > TREE_MAX_LINES) {
      return kept.slice(0, TREE_MAX_LINES).join('\n') + `\n... +${kept.length - TREE_MAX_LINES} more lines`;
    }
    return kept.join('\n');
  },
  { filterName: 'tree' },
);

/** Cursor glob "Result of search in '...' (total N files):" lists. */
export const searchListFilter: RtkFilter = Object.assign(
  (input: string): string => {
    const lines = input.split('\n');
    const header = lines[0] ?? '';
    const paths: string[] = [];
    for (const raw of lines.slice(1)) {
      const t = raw.trim();
      if (t.startsWith('- ')) paths.push(t.slice(2));
    }
    if (paths.length === 0) return input;
    const byDir = new Map<string, string[]>();
    for (const p of paths) {
      const slash = p.lastIndexOf('/');
      const dir = slash === -1 ? '.' : p.slice(0, slash) || '/';
      const list = byDir.get(dir) ?? [];
      list.push(slash === -1 ? p : p.slice(slash + 1));
      byDir.set(dir, list);
    }
    const dirs = [...byDir.keys()].sort();
    let out = `${header}\n${paths.length} files in ${dirs.length} dirs:\n\n`;
    for (const dir of dirs.slice(0, FIND_TOTAL_DIR_MAX)) {
      const names = byDir.get(dir)!;
      out += `${dir}/ (${names.length}):\n`;
      for (const n of names.slice(0, FIND_PER_DIR_MAX)) out += `  ${n}\n`;
      if (names.length > FIND_PER_DIR_MAX) out += `  +${names.length - FIND_PER_DIR_MAX}\n`;
      out += '\n';
    }
    if (dirs.length > FIND_TOTAL_DIR_MAX) out += `+${dirs.length - FIND_TOTAL_DIR_MAX} more dirs\n`;
    return out.replace(/\n+$/, '');
  },
  { filterName: 'search-list' },
);

/** Line-numbered file dumps ("  1|content"): keep head + tail. */
export const readNumberedFilter: RtkFilter = Object.assign(
  (input: string): string => {
    const lines = input.split('\n');
    if (lines.length < TRUNCATE_MIN_LINES) return input;
    const head = lines.slice(0, TRUNCATE_HEAD);
    const tail = lines.slice(lines.length - TRUNCATE_TAIL);
    return [...head, `... +${lines.length - head.length - tail.length} lines truncated (file continues)`, ...tail].join('\n');
  },
  { filterName: 'read-numbered' },
);

/** Generic fallback: collapse consecutive duplicate lines + blank runs, hard cap. */
export const dedupLogFilter: RtkFilter = Object.assign(
  (input: string): string => {
    const out: string[] = [];
    let prev: string | null = null;
    let run = 0;
    let blanks = 0;
    const flush = (): void => {
      if (prev !== null && run > 1) out.push(`  ... (${run - 1} duplicate lines)`);
    };
    for (const line of input.split('\n')) {
      if (line.trim() === '') {
        if (blanks < 1) out.push(line);
        blanks++;
        flush();
        prev = null;
        run = 0;
        continue;
      }
      blanks = 0;
      if (line === prev) {
        run++;
        continue;
      }
      flush();
      out.push(line);
      prev = line;
      run = 1;
      if (out.length >= DEDUP_LINE_MAX) {
        out.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
        return out.join('\n');
      }
    }
    flush();
    return out.join('\n');
  },
  { filterName: 'dedup-log' },
);

/** Last resort: keep head + tail lines of a big unstructured blob. */
export const smartTruncateFilter: RtkFilter = Object.assign(
  (input: string): string => {
    const lines = input.split('\n');
    if (lines.length < TRUNCATE_MIN_LINES) return input;
    const head = lines.slice(0, TRUNCATE_HEAD);
    const tail = lines.slice(lines.length - TRUNCATE_TAIL);
    return [...head, `... +${lines.length - head.length - tail.length} lines truncated`, ...tail].join('\n');
  },
  { filterName: 'smart-truncate' },
);

/* ---- auto-detect + safe entry point ---- */

const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_BUILD =
  /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
const RE_TREE_GLYPH = /[├└]──|│  /;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;
const RE_SEARCH_LIST_HEADER = /^Result of search in '[^']*' \(total \d+ files?\):/;
const RE_NUMBERED_LINE = /^\s*\d+\|/;

function isGrepLine(line: string): boolean {
  const first = line.indexOf(':');
  if (first === -1) return false;
  const second = line.indexOf(':', first + 1);
  if (second === -1) return false;
  return /^\d+$/.test(line.slice(first + 1, second));
}

function isPathLike(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.includes(':')) return false;
  return t.startsWith('.') || t.startsWith('/') || t.includes('/');
}

function isMostlyPorcelain(head: string): boolean {
  const lines = head.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return false;
  const hits = lines.filter((l) => RE_PORCELAIN.test(l)).length;
  return hits / lines.length >= 0.6;
}

function isLineNumbered(lines: string[]): boolean {
  let hits = 0;
  let nonEmpty = 0;
  for (const l of lines.slice(0, 100)) {
    if (!l) continue;
    nonEmpty++;
    if (RE_NUMBERED_LINE.test(l)) hits++;
  }
  return nonEmpty >= 5 && hits / nonEmpty >= READ_NUMBERED_MIN_RATIO;
}

/**
 * Pick the right filter by peeking at the first 1KB. Detection order:
 * git-log → git-diff → git-status → build-output → grep → find → tree →
 * ls → search-list → read-numbered → dedup-log → smart-truncate → null.
 */
export function detectRtkFilter(text: string): RtkFilter | null {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;
  if (RE_GIT_LOG.test(head)) return gitLogFilter;
  if (RE_GIT_DIFF.test(head) || RE_GIT_HUNK.test(head)) return gitDiffFilter;
  if (RE_GIT_STATUS.test(head)) return gitStatusFilter;
  if (RE_BUILD.test(head)) return buildOutputFilter;
  if (isMostlyPorcelain(head)) return gitStatusFilter;

  const lines = head.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.slice(0, 5).some(isGrepLine)) return grepFilter;
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return findFilter;
  if (RE_TREE_GLYPH.test(head)) return treeFilter;
  const lsRows = (head.match(new RegExp(RE_LS_ROW.source, 'gm')) ?? []).length;
  if (RE_LS_TOTAL.test(head) || lsRows >= 3) return lsFilter;
  if (RE_SEARCH_LIST_HEADER.test(head)) return searchListFilter;
  // Line-count gates use the full text — the 1KB head can't hold 250 lines.
  const lineCount = text.split('\n').length;
  if (lineCount >= TRUNCATE_MIN_LINES && isLineNumbered(lines)) return readNumberedFilter;
  if (nonEmpty.length >= 5) return dedupLogFilter;
  if (lineCount >= TRUNCATE_MIN_LINES) return smartTruncateFilter;
  return null;
}

export interface RtkResult {
  text: string;
  saved: number;
  filter: string | null;
}

/**
 * Compress one tool-result blob. Never throws, never returns empty, never
 * grows the input — on any failure the original text comes back unchanged.
 */
export function compressRtkText(text: string): RtkResult {
  const noop = { text, saved: 0, filter: null };
  if (text.length < RTK_MIN_COMPRESS_BYTES) return noop;
  const filter = detectRtkFilter(text);
  if (!filter) return noop;
  let out: string;
  try {
    out = filter(text);
  } catch {
    return noop;
  }
  if (!out || out.length === 0 || out.length >= text.length) return noop;
  return { text: out, saved: text.length - out.length, filter: filter.filterName };
}

export interface RtkStats {
  bytesBefore: number;
  bytesAfter: number;
  hits: { filter: string; saved: number }[];
}

/**
 * Walk an OpenAI/Anthropic request body and compress every tool-result blob
 * in place. Returns byte stats for metrics.
 */
export function compressRtkMessages(body: unknown): RtkStats {
  const stats: RtkStats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  const apply = (text: string): string => {
    stats.bytesBefore += text.length;
    const r = compressRtkText(text);
    stats.bytesAfter += r.text.length;
    if (r.filter) stats.hits.push({ filter: r.filter, saved: r.saved });
    return r.text;
  };
  try {
    const messages = (body as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) return stats;
    for (const msg of messages) {
      if (typeof msg !== 'object' || msg === null) continue;
      const m = msg as { role?: unknown; content?: unknown; type?: unknown; output?: unknown };
      // OpenAI Responses: { type: 'function_call_output', output }
      if (m.type === 'function_call_output') {
        if (typeof m.output === 'string') m.output = apply(m.output);
        else if (Array.isArray(m.output)) {
          for (const part of m.output) {
            const p = part as { type?: unknown; text?: unknown };
            if (p && p.type === 'input_text' && typeof p.text === 'string') p.text = apply(p.text);
          }
        }
        continue;
      }
      // OpenAI: { role: 'tool', content }
      if (m.role === 'tool') {
        if (typeof m.content === 'string') m.content = apply(m.content);
        else if (Array.isArray(m.content)) {
          for (const part of m.content) {
            const p = part as { type?: unknown; text?: unknown };
            if (p && p.type === 'text' && typeof p.text === 'string') p.text = apply(p.text);
          }
        }
        continue;
      }
      // Anthropic: content blocks with type 'tool_result' (skip error traces)
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          const b = block as { type?: unknown; content?: unknown; is_error?: unknown };
          if (!b || b.type !== 'tool_result' || b.is_error === true) continue;
          if (typeof b.content === 'string') b.content = apply(b.content);
          else if (Array.isArray(b.content)) {
            for (const part of b.content) {
              const p = part as { type?: unknown; text?: unknown };
              if (p && p.type === 'text' && typeof p.text === 'string') p.text = apply(p.text);
            }
          }
        }
      }
    }
  } catch {
    /* never break the request */
  }
  return stats;
}
