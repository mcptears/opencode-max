package zen

import (
	"net/http"
	"testing"
	"time"
)

func TestNormalizeBase(t *testing.T) {
	cases := map[string]string{
		"https://opencode.ai/zen/v1":     ConsoleBase,
		"https://opencode.ai/zen/v1/":    ConsoleBase,
		"https://opencode.ai/zen":        ConsoleBase,
		"https://opencode.ai/zen/go/v1":  GoBase,
		"https://opencode.ai/zen/go":     GoBase,
		"https://opencode.ai/inference/": ConsoleBase,
		"https://api.openai.com/v1/":     "https://api.openai.com/v1",
	}
	for in, want := range cases {
		if got := NormalizeBase(in); got != want {
			t.Errorf("NormalizeBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPlanFromBase(t *testing.T) {
	if got := PlanFromBase("https://opencode.ai/zen/go/v1"); got != PlanGo {
		t.Errorf("legacy go base -> %q, want go", got)
	}
	if got := PlanFromBase(GoBase); got != PlanGo {
		t.Errorf("go base -> %q, want go", got)
	}
	if got := PlanFromBase(ConsoleBase); got != PlanConsole {
		t.Errorf("console base -> %q, want console", got)
	}
	if got := BaseForPlan(PlanGo); got != GoBase {
		t.Errorf("BaseForPlan(go) = %q", got)
	}
}

func TestEndpoint(t *testing.T) {
	cases := []struct{ base, path, want string }{
		{ConsoleBase, "/chat/completions", ConsoleBase + "/openai/v1/chat/completions"},
		{ConsoleBase, "/responses", ConsoleBase + "/openai/v1/responses"},
		{ConsoleBase, "/messages", ConsoleBase + "/anthropic/v1/messages"},
		{ConsoleBase, "/models", ConsoleBase + "/v1/models"},
		{GoBase, "/chat/completions", GoBase + "/openai/v1/chat/completions"},
		{ConsoleBase + "/openai/v1", "/chat/completions", ConsoleBase + "/openai/v1/chat/completions"},
		{"https://api.openai.com/v1", "/chat/completions", "https://api.openai.com/v1/chat/completions"},
	}
	for _, c := range cases {
		if got := Endpoint(c.base, c.path); got != c.want {
			t.Errorf("Endpoint(%q, %q) = %q, want %q", c.base, c.path, got, c.want)
		}
	}
}

func TestFreeModels(t *testing.T) {
	for _, m := range []string{"kimi-k3-free", "big-pickle", "big-pickle-latest"} {
		if !IsFreeModel(m) {
			t.Errorf("IsFreeModel(%q) = false, want true", m)
		}
	}
	for _, m := range []string{"kimi-k3", "glm-5.3", ""} {
		if IsFreeModel(m) {
			t.Errorf("IsFreeModel(%q) = true, want false", m)
		}
	}
	if got := PickPaidModel([]string{"x-free", "big-pickle", "kimi-k3"}); got != "kimi-k3" {
		t.Errorf("PickPaidModel = %q, want kimi-k3", got)
	}
	if got := PickPaidModel([]string{"x-free", "big-pickle"}); got != "" {
		t.Errorf("PickPaidModel = %q, want empty", got)
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if got := ParseRetryAfter("12", now); got != 12*time.Second {
		t.Errorf("seconds = %v", got)
	}
	if got := ParseRetryAfter("", now); got != 0 {
		t.Errorf("empty = %v", got)
	}
	if got := ParseRetryAfter("nonsense", now); got != 0 {
		t.Errorf("invalid = %v", got)
	}
	date := now.Add(90 * time.Second).Format(http.TimeFormat)
	if got := ParseRetryAfter(date, now); got != 90*time.Second {
		t.Errorf("http date = %v, want 90s", got)
	}
}

func TestParseUsage(t *testing.T) {
	body := []byte(`{"usage":{"prompt_tokens":1,"cost":0.2,"opencode":{"billing_source":"go","list_cost":0.2,"allowance":0.15,"tokens":{"input":10,"output":5}}}}`)
	u, ok := ParseUsage(body)
	if !ok {
		t.Fatal("ParseUsage returned false")
	}
	if u.BillingSource != "go" || u.Allowance != 0.15 || u.Cost != 0.2 || u.InputTokens != 10 || u.OutputTokens != 5 {
		t.Errorf("usage = %+v", u)
	}
	if _, ok := ParseUsage([]byte(`{"usage":{"prompt_tokens":1}}`)); ok {
		t.Error("plain usage should not be reported as Zen usage")
	}
}
