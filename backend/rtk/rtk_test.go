package rtk

import (
	"fmt"
	"strings"
	"testing"
)

func repeat(s string, n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		b.WriteString(s)
	}
	return b.String()
}

func assertCompresses(t *testing.T, filterName, input string) string {
	t.Helper()
	if len(input) < MinCompressBytes {
		t.Fatalf("fixture for %s is only %d bytes (< %d)", filterName, len(input), MinCompressBytes)
	}
	f := DetectFilter(input)
	if f == nil {
		t.Fatalf("no filter detected for %s fixture", filterName)
	}
	if f.Name != filterName {
		t.Fatalf("detected filter = %q, want %q", f.Name, filterName)
	}
	r := CompressText(input)
	if r.Filter != filterName {
		t.Fatalf("CompressText filter = %q, want %q", r.Filter, filterName)
	}
	if r.Saved <= 0 {
		t.Fatalf("saved = %d, want > 0", r.Saved)
	}
	if len(r.Text) >= len(input) {
		t.Fatal("compressed output must be shorter than input")
	}
	return r.Text
}

func TestSmallBlobUntouched(t *testing.T) {
	in := "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"
	r := CompressText(in)
	if r.Filter != "" || r.Saved != 0 || r.Text != in {
		t.Fatalf("small blob must pass through untouched, got filter=%q saved=%d", r.Filter, r.Saved)
	}
}

func TestGitDiff(t *testing.T) {
	var b strings.Builder
	b.WriteString("diff --git a/main.go b/main.go\nindex abc..def 100644\n--- a/main.go\n+++ b/main.go\n@@ -1,5 +1,6 @@\n package main\n")
	for i := 0; i < 300; i++ {
		b.WriteString("+added line number " + itoa(i) + "\n")
	}
	assertCompresses(t, "git-diff", b.String())
	out := GitDiffFilter.Fn(b.String())
	if !strings.Contains(out, "main.go") {
		t.Fatal("compressed diff should keep the file name")
	}
	if strings.Count(out, "added line number") > hunkMaxLines+5 {
		t.Fatal("hunk should be truncated to ~100 lines")
	}
}

func TestGitLog(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 30; i++ {
		b.WriteString("commit " + strings.Repeat("a", 40) + "\nAuthor: Dev <d@x.io>\nDate:   Mon Oct 11\n\n    Subject line here\n\n    body body body body body\n\ndiff --git a/f b/f\n")
	}
	assertCompresses(t, "git-log", b.String())
}

func TestGitStatus(t *testing.T) {
	var b strings.Builder
	b.WriteString("On branch main\nChanges to be committed:\n")
	for i := 0; i < 40; i++ {
		b.WriteString("\tmodified:   src/file" + itoa(i) + ".go\n")
	}
	b.WriteString("Untracked files:\n")
	for i := 0; i < 20; i++ {
		b.WriteString("\t?? tmp" + itoa(i) + "\n")
	}
	out := assertCompresses(t, "git-status", b.String())
	if !strings.Contains(out, "main") || !strings.Contains(out, "Modified") {
		t.Fatal("status summary should keep branch and modified section")
	}
}

func TestGitStatusPorcelain(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 30; i++ {
		b.WriteString(" M src/file" + itoa(i) + ".go\n")
	}
	for i := 0; i < 20; i++ {
		b.WriteString("?? new" + itoa(i) + ".txt\n")
	}
	assertCompresses(t, "git-status", b.String())
}

func TestBuildOutput(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 200; i++ {
		b.WriteString("   Compiling pkg" + itoa(i) + " v1.0.0\n")
	}
	b.WriteString("error[E0308]: mismatched types\n --> src/main.rs:10:5\n  |\n10 |     foo()\n   |     ^^^\n\nwarning: unused variable\nFinished dev profile in 1.2s\n")
	assertCompresses(t, "build-output", b.String())
	out := BuildOutputFilter.Fn(b.String())
	if !strings.Contains(out, "mismatched types") {
		t.Fatal("build filter must keep the error")
	}
	if strings.Contains(out, "Compiling pkg42") {
		t.Fatal("build filter must drop per-package progress lines")
	}
}

func TestGrep(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 60; i++ {
		b.WriteString("src/a.go:" + itoa(i+1) + ": match of the thing here\n")
	}
	for i := 0; i < 30; i++ {
		b.WriteString("src/b.go:" + itoa(i+1) + ": another match\n")
	}
	out := assertCompresses(t, "grep", b.String())
	if !strings.Contains(out, "90 matches in 2F") {
		t.Fatalf("grep summary wrong:\n%s", out[:200])
	}
}

func TestFind(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 120; i++ {
		b.WriteString("src/pkg/file" + itoa(i) + ".go\n")
	}
	assertCompresses(t, "find", b.String())
}

func TestLs(t *testing.T) {
	var b strings.Builder
	b.WriteString("total 48\n")
	for i := 0; i < 40; i++ {
		b.WriteString("-rw-r--r--  1 root root  1234 Oct 11 12:00 file" + itoa(i) + ".go\n")
	}
	b.WriteString("drwxr-xr-x  2 root root  4096 Oct 11 12:00 subdir\n")
	out := assertCompresses(t, "ls", b.String())
	if !strings.Contains(out, "Summary:") {
		t.Fatal("ls filter should emit a summary")
	}
}

func TestTree(t *testing.T) {
	var b strings.Builder
	b.WriteString("src\n")
	for i := 0; i < 400; i++ {
		b.WriteString("├── file" + itoa(i) + ".go\n")
	}
	b.WriteString("\n400 directories, 400 files\n")
	assertCompresses(t, "tree", b.String())
}

func TestSearchList(t *testing.T) {
	var b strings.Builder
	b.WriteString("Result of search in 'src' (total 60 files):\n")
	for i := 0; i < 60; i++ {
		b.WriteString("- src/pkg/file" + itoa(i) + ".go\n")
	}
	assertCompresses(t, "search-list", b.String())
}

func TestReadNumbered(t *testing.T) {
	var b strings.Builder
	for i := 1; i <= 600; i++ {
		b.WriteString("  " + itoa(i) + "|content of line number " + itoa(i) + " here\n")
	}
	out := assertCompresses(t, "read-numbered", b.String())
	if !strings.Contains(out, "truncated (file continues)") {
		t.Fatal("read-numbered should note the truncation")
	}
}

func TestDedupLog(t *testing.T) {
	var b strings.Builder
	b.WriteString("starting up the server now\n")
	for i := 0; i < 100; i++ {
		b.WriteString("heartbeat ok\n")
	}
	b.WriteString("shutting down now\n")
	out := assertCompresses(t, "dedup-log", b.String())
	if !strings.Contains(out, "duplicate lines") {
		t.Fatal("dedup filter should collapse the heartbeat run")
	}
	if !strings.Contains(out, "starting up") || !strings.Contains(out, "shutting down") {
		t.Fatal("dedup filter should keep unique lines")
	}
}

func TestSmartTruncate(t *testing.T) {
	// Unstructured prose: detection prefers dedup-log (TS-faithful), and
	// unique lines don't compress — so CompressText is a noop. The filter
	// itself is unit-tested directly.
	var b strings.Builder
	for i := 0; i < 400; i++ {
		b.WriteString("lorem ipsum dolor sit amet consectetur adipiscing elit sed do " + itoa(i) + "\n")
	}
	in := b.String()
	if f := DetectFilter(in); f == nil || f.Name != "dedup-log" {
		t.Fatalf("detected = %v, want dedup-log", f)
	}
	if r := CompressText(in); r.Filter != "" {
		t.Fatalf("unique prose should not compress, got filter %q", r.Filter)
	}
	out := SmartTruncateFilter.Fn(in)
	if len(out) >= len(in) {
		t.Fatal("smart-truncate filter should shorten the blob")
	}
	if !strings.Contains(out, "lines truncated") {
		t.Fatal("smart-truncate should note the truncation")
	}
	// Head and tail survive.
	if !strings.Contains(out, "sed do 0") || !strings.Contains(out, "sed do 399") {
		t.Fatal("smart-truncate should keep head and tail")
	}
}

func TestCompressTextNeverGrowsOrEmpties(t *testing.T) {
	inputs := []string{
		repeat("x", 600),
		"diff --git " + repeat("z", 600),
		repeat("a:b:c\n", 200),
	}
	for _, in := range inputs {
		r := CompressText(in)
		if r.Text == "" {
			t.Fatal("CompressText must never return empty")
		}
		if len(r.Text) > len(in) {
			t.Fatal("CompressText must never grow the input")
		}
	}
}

// bigDiff builds a realistic single-hunk diff that the git-diff filter
// actually compresses (many changed lines in one hunk).
func bigDiff() string {
	var b strings.Builder
	b.WriteString("diff --git a/main.go b/main.go\nindex abc..def 100644\n--- a/main.go\n+++ b/main.go\n@@ -1,10 +1,300 @@\n package main\n")
	for i := 0; i < 150; i++ {
		fmt.Fprintf(&b, "-old implementation line %d with some content here\n", i)
	}
	for i := 0; i < 150; i++ {
		fmt.Fprintf(&b, "+new implementation line %d with some content here\n", i)
	}
	return b.String()
}

func TestCompressMessagesOpenAI(t *testing.T) {
	diff := bigDiff()
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{"role": "tool", "content": diff},
			map[string]any{"role": "tool", "content": []any{
				map[string]any{"type": "text", "text": diff},
			}},
			map[string]any{"type": "function_call_output", "output": diff},
		},
	}
	stats := CompressMessages(body)
	if stats.BytesAfter >= stats.BytesBefore {
		t.Fatal("messages should shrink")
	}
	if len(stats.Hits) != 3 {
		t.Fatalf("hits = %d, want 3", len(stats.Hits))
	}
	for _, h := range stats.Hits {
		if h.Filter != "git-diff" {
			t.Fatalf("hit filter = %q, want git-diff", h.Filter)
		}
	}
}

func TestCompressMessagesAnthropicSkipsErrors(t *testing.T) {
	diff := bigDiff()
	errBlock := map[string]any{"type": "tool_result", "is_error": true, "content": diff}
	okBlock := map[string]any{"type": "tool_result", "content": diff}
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": []any{errBlock, okBlock}},
		},
	}
	stats := CompressMessages(body)
	if len(stats.Hits) != 1 {
		t.Fatalf("hits = %d, want 1 (error trace must be skipped)", len(stats.Hits))
	}
	if errBlock["content"] != diff {
		t.Fatal("is_error block must be left untouched")
	}
}

func TestCompressMessagesNeverPanics(t *testing.T) {
	// Malformed shapes must not panic.
	for _, body := range []any{
		nil,
		map[string]any{},
		map[string]any{"messages": "nope"},
		map[string]any{"messages": []any{nil, 42, "str"}},
		map[string]any{"messages": []any{map[string]any{"role": "tool", "content": 42}}},
	} {
		CompressMessages(body)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
