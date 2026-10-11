// Package rtk implements the RTK-style token saver: content-aware
// compression for tool_result payloads.
//
// Agentic coding loops routinely stuff tens of KB of tool output (git diffs,
// grep hits, build logs, ls dumps…) into prompts. Instead of dumb truncation,
// RTK peeks at each blob, detects what *kind* of output it is, and applies a
// filter that keeps the signal while dropping the noise — the same answer for
// far fewer tokens.
//
// Safety rules (never break a request):
//   - Blobs under MinCompressBytes pass through untouched.
//   - A filter that panics, returns empty, or grows the input is discarded
//     and the original text is kept.
package rtk

import (
	"fmt"
	"regexp"
	"strings"
)

// MinCompressBytes is the size threshold below which blobs pass through untouched.
const MinCompressBytes = 500

const (
	detectWindow         = 1024
	hunkMaxLines         = 100
	diffMaxLines         = 500
	logMaxLines          = 200
	dedupLineMax         = 2000
	grepPerFileMax       = 10
	findPerDirMax        = 10
	findTotalDirMax      = 20
	statusMaxFiles       = 10
	treeMaxLines         = 200
	truncateHead         = 120
	truncateTail         = 60
	truncateMinLines     = 250
	readNumberedMinRatio = 0.7
)

// noiseDirs are directory names skipped by the ls filter.
var noiseDirs = map[string]bool{
	"node_modules": true, ".git": true, "target": true, "__pycache__": true,
	".next": true, "dist": true, "build": true, ".cache": true, ".turbo": true,
	".vercel": true, ".pytest_cache": true, ".mypy_cache": true, ".tox": true,
	".venv": true, "venv": true, "coverage": true, ".nyc_output": true,
	".DS_Store": true, "Thumbs.db": true, ".idea": true, ".vscode": true, ".vs": true,
}

// Filter is a named content-aware compression filter.
type Filter struct {
	Name string
	Fn   func(string) string
}

func named(name string, fn func(string) string) *Filter {
	return &Filter{Name: name, Fn: fn}
}

// GitDiffFilter: git diff — per-hunk truncation + per-file +/- summary.
var GitDiffFilter = named("git-diff", func(diff string) string {
	var out []string
	var file string
	added, removed := 0, 0
	inHunk := false
	shown, skipped := 0, 0
	truncated := false

	flushSkipped := func() {
		if skipped > 0 {
			out = append(out, fmt.Sprintf("  ... (%d lines truncated)", skipped))
			truncated = true
			skipped = 0
		}
	}
	flushFile := func() {
		if file != "" && (added > 0 || removed > 0) {
			out = append(out, fmt.Sprintf("  +%d -%d", added, removed))
		}
	}

outer:
	for _, line := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git"):
			flushSkipped()
			flushFile()
			parts := strings.Split(line, " b/")
			if len(parts) > 1 {
				file = strings.Join(parts[1:], " b/")
			} else {
				file = "unknown"
			}
			out = append(out, "\n"+file)
			added, removed = 0, 0
			inHunk = false
			shown = 0
		case strings.HasPrefix(line, "@@"):
			flushSkipped()
			inHunk = true
			shown = 0
			out = append(out, "  "+line)
		case inHunk:
			isAdd := strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++")
			isDel := strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---")
			if isAdd || isDel {
				if isAdd {
					added++
				} else {
					removed++
				}
				if shown < hunkMaxLines {
					out = append(out, "  "+line)
					shown++
				} else {
					skipped++
				}
			} else if shown < hunkMaxLines && shown > 0 && !strings.HasPrefix(line, "\\") {
				out = append(out, "  "+line)
				shown++
			}
		}
		if len(out) >= diffMaxLines {
			out = append(out, "\n... (more changes truncated)")
			truncated = true
			break outer
		}
	}
	flushSkipped()
	flushFile()
	if truncated {
		out = append(out, "[use git diff for the full output]")
	}
	return strings.Join(out, "\n")
})

var (
	reCommitLine   = regexp.MustCompile(`(?i)^commit [0-9a-f]{7,40}$`)
	reCommitGraph  = regexp.MustCompile(`(?i)^[*|/\\ ]+commit [0-9a-f]{7,40}`)
	reAuthorDate   = regexp.MustCompile(`(?i)^[*|/\\ ]*(Author|Date):`)
	reSubject      = regexp.MustCompile(`^[*|/\\ ]*    \S`)
	reFilesChanged = regexp.MustCompile(`^\d+ files? changed`)
	reDiffGit      = regexp.MustCompile(`^diff --git `)
	reGraphHash    = regexp.MustCompile(`(?i)^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)`)
	reBareHash     = regexp.MustCompile(`^[0-9a-f]{7,40}\s+`)
	reGraphOnly    = regexp.MustCompile(`^[*|/\\ ]+$`)
)

// GitLogFilter: git log — keep commit headers, author/date, subject; drop
// bodies and embedded diffs.
var GitLogFilter = named("git-log", func(text string) string {
	var out []string
	skipped := 0
	inCommit := false
	subjectSeen := false
	push := func(l string) {
		if len(out) < logMaxLines {
			out = append(out, l)
		} else {
			skipped++
		}
	}
	for _, raw := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(raw)
		if reCommitLine.MatchString(trimmed) || reCommitGraph.MatchString(trimmed) {
			inCommit = true
			subjectSeen = false
			push(raw)
			continue
		}
		if inCommit {
			switch {
			case reAuthorDate.MatchString(trimmed):
				push(trimmed)
			case trimmed == "":
				// skip blank lines inside commits
			case !subjectSeen && reSubject.MatchString(raw):
				push("  Subject: " + trimmed)
				subjectSeen = true
			case reFilesChanged.MatchString(trimmed):
				push("  " + trimmed)
			case reDiffGit.MatchString(trimmed):
				push("  ... diff body omitted")
			}
			continue
		}
		if m := reGraphHash.FindStringSubmatch(trimmed); m != nil {
			push(m[1])
			continue
		}
		if reBareHash.MatchString(trimmed) {
			push(trimmed)
			continue
		}
		if reGraphOnly.MatchString(trimmed) {
			continue
		}
		push(trimmed)
	}
	if skipped > 0 {
		out = append(out, fmt.Sprintf("... (%d more lines)", skipped))
	}
	result := strings.Join(out, "\n")
	if result == "" {
		return text
	}
	return result
})

var (
	reLongBranch = regexp.MustCompile(`^On branch (\S+)`)
	reLongEntry  = regexp.MustCompile(`^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$`)
	rePorcelain  = regexp.MustCompile(`^[ MADRCU?!][ MADRCU?!] `)
)

// GitStatusFilter: git status — parse porcelain/long form into a compact summary.
var GitStatusFilter = named("git-status", func(text string) string {
	var branch string
	var staged, modified, untracked []string
	conflicts := 0
	for _, raw := range strings.Split(text, "\n") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		if m := reLongBranch.FindStringSubmatch(raw); m != nil {
			branch = m[1]
			continue
		}
		if strings.HasPrefix(raw, "##") {
			branch = strings.TrimSpace(strings.TrimPrefix(raw, "##"))
			continue
		}
		if len(raw) >= 3 && rePorcelain.MatchString(raw) {
			x, y := raw[0], raw[1]
			file := raw[3:]
			if raw[:2] == "??" {
				untracked = append(untracked, file)
				continue
			}
			if strings.ContainsRune("MADRC", rune(x)) {
				staged = append(staged, file)
			} else if x == 'U' {
				conflicts++
			}
			if y == 'M' || y == 'D' {
				modified = append(modified, file)
			}
			continue
		}
		if m := reLongEntry.FindStringSubmatch(raw); m != nil {
			kind, file := m[1], strings.TrimSpace(m[2])
			switch kind {
			case "both modified":
				conflicts++
			case "modified", "deleted":
				modified = append(modified, file)
			default:
				staged = append(staged, file)
			}
		}
	}
	list := func(files []string) string {
		var b strings.Builder
		for i, f := range files {
			if i >= statusMaxFiles {
				break
			}
			b.WriteString("   " + f + "\n")
		}
		if len(files) > statusMaxFiles {
			fmt.Fprintf(&b, "   ... +%d more\n", len(files)-statusMaxFiles)
		}
		return b.String()
	}
	var out strings.Builder
	if branch != "" {
		out.WriteString("* " + branch + "\n")
	}
	if len(staged) > 0 {
		fmt.Fprintf(&out, "+ Staged: %d files\n%s\n", len(staged), list(staged))
	}
	if len(modified) > 0 {
		fmt.Fprintf(&out, "~ Modified: %d files\n%s\n", len(modified), list(modified))
	}
	if len(untracked) > 0 {
		fmt.Fprintf(&out, "? Untracked: %d files\n%s\n", len(untracked), list(untracked))
	}
	if conflicts > 0 {
		fmt.Fprintf(&out, "conflicts: %d files\n", conflicts)
	}
	result := out.String()
	if result == "" {
		return "clean — nothing to commit"
	}
	return strings.TrimRight(result, "\n")
})

var (
	reCargoCont   = regexp.MustCompile(`^\s*(-->|\||\d+\s*\||=)`)
	reNpmErr      = regexp.MustCompile(`(?i)^npm (ERR!|error)`)
	reYarnErr     = regexp.MustCompile(`(?i)^yarn error`)
	reNpmDeprec   = regexp.MustCompile(`(?i)^npm warn deprecated`)
	reNpmWarn     = regexp.MustCompile(`(?i)^npm warn`)
	reYarnWarn    = regexp.MustCompile(`(?i)^yarn warn`)
	reBracketWarn = regexp.MustCompile(`(?i)^\[WARNING\]`)
	reErrBrack    = regexp.MustCompile(`(?i)^error(\[|:)`)
	reWarnBrack   = regexp.MustCompile(`(?i)^warning(\[|:)`)
	reErrColon    = regexp.MustCompile(`(?i)^ERROR:`)
	reErrTag      = regexp.MustCompile(`(?i)^\[ERROR\]`)
	reBuildFailed = regexp.MustCompile(`(?i)^BUILD FAILED`)
	reCompiling   = regexp.MustCompile(`(?i)^\s*Compiling\s+\S+`)
	reDownloading = regexp.MustCompile(`(?i)^\s*Downloading\s+\S+`)
	reFetching    = regexp.MustCompile(`(?i)^Fetching\s+`)
	reSummary1    = regexp.MustCompile(`(?i)^(added|removed|changed|audited|installed)\s+\d+\s+package`)
	reFinished    = regexp.MustCompile(`(?i)^\s*Finished\s+`)
	reBuildOK     = regexp.MustCompile(`(?i)^BUILD SUCCESS`)
	reCountLine   = regexp.MustCompile(`(?i)^\d+\s+(vulnerabilities|packages?|warnings?|errors?)`)
	reSuccessInst = regexp.MustCompile(`(?i)^Successfully (installed|built)`)
)

// BuildOutputFilter: build output — keep errors, warnings, summary;
// drop progress/download noise.
var BuildOutputFilter = named("build-output", func(text string) string {
	var errors, warnings, deprecations []string
	var summary *string
	compiling, downloading := 0, 0
	inCargoError := false
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if inCargoError {
			if t == "" {
				inCargoError = false
				continue
			}
			if reCargoCont.MatchString(line) {
				errors = append(errors, line)
				continue
			}
			inCargoError = false
		}
		if t == "" {
			continue
		}
		switch {
		case reNpmErr.MatchString(t) || reYarnErr.MatchString(t):
			errors = append(errors, line)
		case reNpmDeprec.MatchString(t):
			deprecations = append(deprecations, line)
		case reNpmWarn.MatchString(t) || reYarnWarn.MatchString(t) || reBracketWarn.MatchString(t):
			warnings = append(warnings, line)
		case reErrBrack.MatchString(t) || reWarnBrack.MatchString(t) ||
			strings.HasPrefix(t, "error -->") || strings.HasPrefix(t, "warning -->"):
			if strings.HasPrefix(strings.ToLower(t), "error") {
				errors = append(errors, line)
			} else {
				warnings = append(warnings, line)
			}
			inCargoError = true
		case reErrColon.MatchString(t) || reErrTag.MatchString(t) || reBuildFailed.MatchString(t):
			errors = append(errors, line)
		case reCompiling.MatchString(t):
			compiling++
		case reDownloading.MatchString(t) || reFetching.MatchString(t):
			downloading++
		case reSummary1.MatchString(t) || reFinished.MatchString(t) || reBuildOK.MatchString(t) ||
			reCountLine.MatchString(t) || reSuccessInst.MatchString(t):
			if summary == nil {
				s := line
				summary = &s
			} else {
				s := *summary + "\n" + line
				summary = &s
			}
		}
	}
	var out strings.Builder
	for i, d := range deprecations {
		if i >= 3 {
			break
		}
		out.WriteString(d + "\n")
	}
	if len(deprecations) > 3 {
		fmt.Fprintf(&out, "... +%d more deprecated packages\n", len(deprecations)-3)
	}
	if compiling > 0 {
		fmt.Fprintf(&out, "Compiled %d packages\n", compiling)
	}
	if downloading > 0 {
		fmt.Fprintf(&out, "Downloaded %d packages\n", downloading)
	}
	for _, e := range errors {
		out.WriteString(e + "\n")
	}
	for i, w := range warnings {
		if i >= 5 {
			break
		}
		out.WriteString(w + "\n")
	}
	if len(warnings) > 5 {
		fmt.Fprintf(&out, "... +%d more warnings\n", len(warnings)-5)
	}
	if summary != nil {
		out.WriteString(*summary + "\n")
	}
	result := strings.TrimRight(out.String(), "\n")
	if result == "" {
		return text
	}
	return result
})

var reDigits = regexp.MustCompile(`^\d+$`)

// GrepFilter: grep output (file:line:content) — group by file, cap matches per file.
var GrepFilter = named("grep", func(input string) string {
	byFile := map[string][][2]string{}
	var fileOrder []string
	total := 0
	for _, line := range strings.Split(input, "\n") {
		first := strings.Index(line, ":")
		if first == -1 {
			continue
		}
		second := strings.Index(line[first+1:], ":")
		if second == -1 {
			continue
		}
		second += first + 1
		file := line[:first]
		lineNo := line[first+1 : second]
		content := line[second+1:]
		if !reDigits.MatchString(lineNo) {
			continue
		}
		total++
		if _, ok := byFile[file]; !ok {
			fileOrder = append(fileOrder, file)
		}
		byFile[file] = append(byFile[file], [2]string{lineNo, content})
	}
	if total == 0 {
		return input
	}
	files := append([]string(nil), fileOrder...)
	sortStrings(files)
	var out strings.Builder
	fmt.Fprintf(&out, "%d matches in %dF:\n\n", total, len(files))
	for _, file := range files {
		matches := byFile[file]
		fmt.Fprintf(&out, "[file] %s (%d):\n", file, len(matches))
		for i, m := range matches {
			if i >= grepPerFileMax {
				break
			}
			fmt.Fprintf(&out, "  %4s: %s\n", m[0], strings.TrimSpace(m[1]))
		}
		if len(matches) > grepPerFileMax {
			fmt.Fprintf(&out, "  +%d\n", len(matches)-grepPerFileMax)
		}
		out.WriteString("\n")
	}
	return out.String()
})

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// FindFilter: find output (bare paths) — group basenames by directory.
var FindFilter = named("find", func(input string) string {
	var lines []string
	for _, l := range strings.Split(input, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return input
	}
	byDir := map[string][]string{}
	var dirOrder []string
	for _, p := range lines {
		lastSep := strings.LastIndexAny(p, "/\\")
		var dir, base string
		if lastSep == -1 {
			dir, base = ".", p
		} else {
			dir = p[:lastSep]
			if dir == "" {
				dir = "/"
			}
			base = p[lastSep+1:]
		}
		if _, ok := byDir[dir]; !ok {
			dirOrder = append(dirOrder, dir)
		}
		byDir[dir] = append(byDir[dir], base)
	}
	dirs := append([]string(nil), dirOrder...)
	sortStrings(dirs)
	var out strings.Builder
	fmt.Fprintf(&out, "%d files in %d dirs:\n\n", len(lines), len(dirs))
	for i, dir := range dirs {
		if i >= findTotalDirMax {
			break
		}
		files := byDir[dir]
		fmt.Fprintf(&out, "%s/  (%d)\n", strings.ReplaceAll(dir, "\\", "/"), len(files))
		for j, f := range files {
			if j >= findPerDirMax {
				break
			}
			out.WriteString("  " + f + "\n")
		}
		if len(files) > findPerDirMax {
			fmt.Fprintf(&out, "  +%d\n", len(files)-findPerDirMax)
		}
	}
	if len(dirs) > findTotalDirMax {
		fmt.Fprintf(&out, "\n+%d more dirs\n", len(dirs)-findTotalDirMax)
	}
	return out.String()
})

var reLsDate = regexp.MustCompile(`\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+`)

func humanSize(b int64) string {
	switch {
	case b >= 1048576:
		return fmt.Sprintf("%.1fM", float64(b)/1048576)
	case b >= 1024:
		return fmt.Sprintf("%.1fK", float64(b)/1024)
	default:
		return fmt.Sprintf("%dB", b)
	}
}

// LsFilter: ls -la output — compact to dirs + files with sizes, skip noise dirs.
var LsFilter = named("ls", func(input string) string {
	var dirs []string
	var files [][2]string
	byExt := map[string]int{}
	var extOrder []string
	for _, line := range strings.Split(input, "\n") {
		if strings.HasPrefix(line, "total ") || line == "" {
			continue
		}
		loc := reLsDate.FindStringIndex(line)
		if loc == nil {
			continue
		}
		name := line[loc[1]:]
		before := strings.Fields(line[:loc[0]])
		if len(before) < 4 || name == "." || name == ".." || noiseDirs[name] {
			continue
		}
		typ := before[0][0]
		var size int64
		for i := len(before) - 1; i >= 0; i-- {
			if reDigits.MatchString(before[i]) {
				fmt.Sscan(before[i], &size)
				break
			}
		}
		if typ == 'd' {
			dirs = append(dirs, name)
		} else if typ == '-' || typ == 'l' {
			dot := strings.LastIndex(name, ".")
			ext := "no ext"
			if dot > 0 {
				ext = name[dot:]
			}
			if _, ok := byExt[ext]; !ok {
				extOrder = append(extOrder, ext)
			}
			byExt[ext]++
			files = append(files, [2]string{name, humanSize(size)})
		}
	}
	if len(dirs) == 0 && len(files) == 0 {
		return input
	}
	var out strings.Builder
	for _, d := range dirs {
		out.WriteString(d + "/\n")
	}
	for _, f := range files {
		out.WriteString(f[0] + "  " + f[1] + "\n")
	}
	fmt.Fprintf(&out, "\nSummary: %d files, %d dirs", len(files), len(dirs))
	if len(byExt) > 0 {
		type kv struct {
			k string
			v int
		}
		var top []kv
		for _, e := range extOrder {
			top = append(top, kv{e, byExt[e]})
		}
		// sort by count desc (stable by first-seen order)
		for i := 1; i < len(top); i++ {
			for j := i; j > 0 && top[j].v > top[j-1].v; j-- {
				top[j], top[j-1] = top[j-1], top[j]
			}
		}
		if len(top) > 5 {
			top = top[:5]
		}
		parts := make([]string, 0, len(top))
		for _, t := range top {
			parts = append(parts, fmt.Sprintf("%d %s", t.v, t.k))
		}
		out.WriteString(" (" + strings.Join(parts, ", "))
		if len(byExt) > 5 {
			fmt.Fprintf(&out, ", +%d more", len(byExt)-5)
		}
		out.WriteString(")")
	}
	return out.String()
})

// TreeFilter: tree output — drop the summary line and cap length.
var TreeFilter = named("tree", func(input string) string {
	var kept []string
	for _, line := range strings.Split(input, "\n") {
		if strings.Contains(line, "director") && strings.Contains(line, "file") {
			continue
		}
		if strings.TrimSpace(line) == "" && len(kept) == 0 {
			continue
		}
		kept = append(kept, line)
	}
	for len(kept) > 0 && strings.TrimSpace(kept[len(kept)-1]) == "" {
		kept = kept[:len(kept)-1]
	}
	if len(kept) > treeMaxLines {
		return strings.Join(kept[:treeMaxLines], "\n") +
			fmt.Sprintf("\n... +%d more lines", len(kept)-treeMaxLines)
	}
	return strings.Join(kept, "\n")
})

// SearchListFilter: Cursor glob "Result of search in '...' (total N files):" lists.
var SearchListFilter = named("search-list", func(input string) string {
	lines := strings.Split(input, "\n")
	header := ""
	if len(lines) > 0 {
		header = lines[0]
	}
	var paths []string
	for _, raw := range lines[1:] {
		t := strings.TrimSpace(raw)
		if strings.HasPrefix(t, "- ") {
			paths = append(paths, t[2:])
		}
	}
	if len(paths) == 0 {
		return input
	}
	byDir := map[string][]string{}
	var dirOrder []string
	for _, p := range paths {
		slash := strings.LastIndex(p, "/")
		var dir, base string
		if slash == -1 {
			dir, base = ".", p
		} else {
			dir = p[:slash]
			if dir == "" {
				dir = "/"
			}
			base = p[slash+1:]
		}
		if _, ok := byDir[dir]; !ok {
			dirOrder = append(dirOrder, dir)
		}
		byDir[dir] = append(byDir[dir], base)
	}
	dirs := append([]string(nil), dirOrder...)
	sortStrings(dirs)
	var out strings.Builder
	fmt.Fprintf(&out, "%s\n%d files in %d dirs:\n\n", header, len(paths), len(dirs))
	for i, dir := range dirs {
		if i >= findTotalDirMax {
			break
		}
		names := byDir[dir]
		fmt.Fprintf(&out, "%s/ (%d):\n", dir, len(names))
		for j, n := range names {
			if j >= findPerDirMax {
				break
			}
			out.WriteString("  " + n + "\n")
		}
		if len(names) > findPerDirMax {
			fmt.Fprintf(&out, "  +%d\n", len(names)-findPerDirMax)
		}
		out.WriteString("\n")
	}
	if len(dirs) > findTotalDirMax {
		fmt.Fprintf(&out, "+%d more dirs\n", len(dirs)-findTotalDirMax)
	}
	return strings.TrimRight(out.String(), "\n")
})

// ReadNumberedFilter: line-numbered file dumps ("  1|content") — keep head + tail.
var ReadNumberedFilter = named("read-numbered", func(input string) string {
	lines := strings.Split(input, "\n")
	if len(lines) < truncateMinLines {
		return input
	}
	head := lines[:truncateHead]
	tail := lines[len(lines)-truncateTail:]
	out := append(append([]string{}, head...),
		fmt.Sprintf("... +%d lines truncated (file continues)", len(lines)-len(head)-len(tail)))
	out = append(out, tail...)
	return strings.Join(out, "\n")
})

// DedupLogFilter: generic fallback — collapse consecutive duplicate lines +
// blank runs, hard cap.
var DedupLogFilter = named("dedup-log", func(input string) string {
	var out []string
	var prev string
	hasPrev := false
	run := 0
	blanks := 0
	flush := func() {
		if hasPrev && run > 1 {
			out = append(out, fmt.Sprintf("  ... (%d duplicate lines)", run-1))
		}
	}
	for _, line := range strings.Split(input, "\n") {
		if strings.TrimSpace(line) == "" {
			if blanks < 1 {
				out = append(out, line)
			}
			blanks++
			flush()
			hasPrev = false
			run = 0
			continue
		}
		blanks = 0
		if hasPrev && line == prev {
			run++
			continue
		}
		flush()
		out = append(out, line)
		prev = line
		hasPrev = true
		run = 1
		if len(out) >= dedupLineMax {
			out = append(out, fmt.Sprintf("... (truncated at %d lines)", dedupLineMax))
			return strings.Join(out, "\n")
		}
	}
	flush()
	return strings.Join(out, "\n")
})

// SmartTruncateFilter: last resort — keep head + tail lines of a big
// unstructured blob.
var SmartTruncateFilter = named("smart-truncate", func(input string) string {
	lines := strings.Split(input, "\n")
	if len(lines) < truncateMinLines {
		return input
	}
	head := lines[:truncateHead]
	tail := lines[len(lines)-truncateTail:]
	out := append(append([]string{}, head...),
		fmt.Sprintf("... +%d lines truncated", len(lines)-len(head)-len(tail)))
	out = append(out, tail...)
	return strings.Join(out, "\n")
})

/* ---- auto-detect ---- */

var (
	reGitDiff         = regexp.MustCompile(`(?m)^diff --git `)
	reGitHunk         = regexp.MustCompile(`(?m)^@@ `)
	reGitStatus       = regexp.MustCompile(`(?m)^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:`)
	reGitLog          = regexp.MustCompile(`(?m)^[*|/\\ ]*commit [0-9a-f]{7,40}$`)
	rePorcelainDetect = regexp.MustCompile(`(?m)^[ MADRCU?!][ MADRCU?!] \S`)
	reBuildDetect     = regexp.MustCompile(`(?im)^(?:npm (?:warn|error|ERR!)|yarn (?:warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (?:SUCCESS|FAILED)|\s*Finished\s+|Successfully (?:installed|built)|ERROR:)`)
	reTreeGlyph       = regexp.MustCompile(`[├└]──|│  `)
	reLsRow           = regexp.MustCompile(`^[-dlbcps][rwx-]{9}`)
	reLsTotal         = regexp.MustCompile(`(?m)^total \d+$`)
	reSearchListHdr   = regexp.MustCompile(`^Result of search in '[^']*' \(total \d+ files?\):`)
	reNumberedLine    = regexp.MustCompile(`^\s*\d+\|`)
)

func isGrepLine(line string) bool {
	first := strings.Index(line, ":")
	if first == -1 {
		return false
	}
	second := strings.Index(line[first+1:], ":")
	if second == -1 {
		return false
	}
	return reDigits.MatchString(line[first+1 : first+1+second])
}

func isPathLike(line string) bool {
	t := strings.TrimSpace(line)
	if t == "" {
		return false
	}
	if matched, _ := regexp.MatchString(`^[A-Za-z]:[\\/]`, t); matched {
		return true
	}
	if strings.Contains(t, ":") {
		return false
	}
	return strings.HasPrefix(t, ".") || strings.HasPrefix(t, "/") || strings.Contains(t, "/")
}

func isMostlyPorcelain(head string) bool {
	var lines []string
	for _, l := range strings.Split(head, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) < 3 {
		return false
	}
	hits := 0
	for _, l := range lines {
		if rePorcelainDetect.MatchString(l) {
			hits++
		}
	}
	return float64(hits)/float64(len(lines)) >= 0.6
}

func isLineNumbered(lines []string) bool {
	hits, nonEmpty := 0, 0
	for i, l := range lines {
		if i >= 100 {
			break
		}
		if l == "" {
			continue
		}
		nonEmpty++
		if reNumberedLine.MatchString(l) {
			hits++
		}
	}
	return nonEmpty >= 5 && float64(hits)/float64(nonEmpty) >= readNumberedMinRatio
}

// DetectFilter picks the right filter by peeking at the first 1KB.
// Detection order: git-log → git-diff → git-status → build-output → grep →
// find → tree → ls → search-list → read-numbered → dedup-log →
// smart-truncate → nil.
func DetectFilter(text string) *Filter {
	head := text
	if len(text) > detectWindow {
		head = text[:detectWindow]
	}
	switch {
	case reGitLog.MatchString(head):
		return GitLogFilter
	case reGitDiff.MatchString(head) || reGitHunk.MatchString(head):
		return GitDiffFilter
	case reGitStatus.MatchString(head):
		return GitStatusFilter
	case reBuildDetect.MatchString(head):
		return BuildOutputFilter
	case isMostlyPorcelain(head):
		return GitStatusFilter
	}

	lines := strings.Split(head, "\n")
	var nonEmpty []string
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			nonEmpty = append(nonEmpty, l)
		}
	}
	someGrep := false
	for i, l := range nonEmpty {
		if i >= 5 {
			break
		}
		if isGrepLine(l) {
			someGrep = true
			break
		}
	}
	if someGrep {
		return GrepFilter
	}
	if len(nonEmpty) >= 3 {
		allPaths := true
		for _, l := range nonEmpty {
			if !isPathLike(l) {
				allPaths = false
				break
			}
		}
		if allPaths {
			return FindFilter
		}
	}
	if reTreeGlyph.MatchString(head) {
		return TreeFilter
	}
	lsRows := 0
	for _, l := range lines {
		if reLsRow.MatchString(l) {
			lsRows++
		}
	}
	if reLsTotal.MatchString(head) || lsRows >= 3 {
		return LsFilter
	}
	if reSearchListHdr.MatchString(head) {
		return SearchListFilter
	}
	// Line-count gates use the full text — the 1KB head can't hold 250 lines.
	lineCount := len(strings.Split(text, "\n"))
	if lineCount >= truncateMinLines && isLineNumbered(lines) {
		return ReadNumberedFilter
	}
	if len(nonEmpty) >= 5 {
		return DedupLogFilter
	}
	if lineCount >= truncateMinLines {
		return SmartTruncateFilter
	}
	return nil
}

// Result is the outcome of compressing one blob.
type Result struct {
	Text   string
	Saved  int
	Filter string // filter name, or "" when untouched
}

// CompressText compresses one tool-result blob. It never panics, never
// returns empty, never grows the input — on any failure the original text
// comes back unchanged.
func CompressText(text string) (result Result) {
	noop := Result{Text: text}
	if len(text) < MinCompressBytes {
		return noop
	}
	filter := DetectFilter(text)
	if filter == nil {
		return noop
	}
	out := func() (s string) {
		defer func() {
			if recover() != nil {
				s = ""
			}
		}()
		return filter.Fn(text)
	}()
	if out == "" || len(out) >= len(text) {
		return noop
	}
	return Result{Text: out, Saved: len(text) - len(out), Filter: filter.Name}
}

// Stats accumulates byte stats for CompressMessages.
type Stats struct {
	BytesBefore int
	BytesAfter  int
	Hits        []Hit
}

// Hit records one successful filter application.
type Hit struct {
	Filter string
	Saved  int
}

// CompressMessages walks an OpenAI/Anthropic request body and compresses
// every tool-result blob in place. It mutates map[string]any message trees
// and returns byte stats for metrics. It never breaks the request.
func CompressMessages(body any) (stats Stats) {
	apply := func(text string) string {
		stats.BytesBefore += len(text)
		r := CompressText(text)
		stats.BytesAfter += len(r.Text)
		if r.Filter != "" {
			stats.Hits = append(stats.Hits, Hit{Filter: r.Filter, Saved: r.Saved})
		}
		return r.Text
	}
	defer func() {
		_ = recover()
	}()
	m, ok := body.(map[string]any)
	if !ok {
		return stats
	}
	messages, ok := m["messages"].([]any)
	if !ok {
		return stats
	}
	for _, msg := range messages {
		mm, ok := msg.(map[string]any)
		if !ok {
			continue
		}
		// OpenAI Responses: { type: 'function_call_output', output }
		if mm["type"] == "function_call_output" {
			switch o := mm["output"].(type) {
			case string:
				mm["output"] = apply(o)
			case []any:
				for _, part := range o {
					p, ok := part.(map[string]any)
					if ok && p["type"] == "input_text" {
						if t, ok := p["text"].(string); ok {
							p["text"] = apply(t)
						}
					}
				}
			}
			continue
		}
		// OpenAI: { role: 'tool', content }
		if mm["role"] == "tool" {
			switch c := mm["content"].(type) {
			case string:
				mm["content"] = apply(c)
			case []any:
				for _, part := range c {
					p, ok := part.(map[string]any)
					if ok && p["type"] == "text" {
						if t, ok := p["text"].(string); ok {
							p["text"] = apply(t)
						}
					}
				}
			}
			continue
		}
		// Anthropic: content blocks with type 'tool_result' (skip error traces)
		if content, ok := mm["content"].([]any); ok {
			for _, block := range content {
				b, ok := block.(map[string]any)
				if !ok || b["type"] != "tool_result" || b["is_error"] == true {
					continue
				}
				switch c := b["content"].(type) {
				case string:
					b["content"] = apply(c)
				case []any:
					for _, part := range c {
						p, ok := part.(map[string]any)
						if ok && p["type"] == "text" {
							if t, ok := p["text"].(string); ok {
								p["text"] = apply(t)
							}
						}
					}
				}
			}
		}
	}
	return stats
}
