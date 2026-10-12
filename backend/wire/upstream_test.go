package wire

import "testing"

func TestZenUserAgent(t *testing.T) {
	if got := zenUserAgent("https://opencode.ai/zen/v1"); got != "opencode/1.18.31" {
		t.Fatalf("zen base: got %q", got)
	}
	if got := zenUserAgent("https://opencode.ai/zen/go/v1"); got != "opencode/1.18.31" {
		t.Fatalf("zen go base: got %q", got)
	}
	if got := zenUserAgent("https://api.openai.com/v1"); got != "" {
		t.Fatalf("non-zen base: got %q, want empty", got)
	}
	if got := zenUserAgent(""); got != "" {
		t.Fatalf("empty base: got %q, want empty", got)
	}
}
