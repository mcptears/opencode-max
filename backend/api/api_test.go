package api

import (
	"strings"
	"testing"
)

func TestExtractModel(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"chat completions", `{"model":"qwen3.7-plus","messages":[]}`, "qwen3.7-plus"},
		{"missing model", `{"messages":[]}`, ""},
		{"non-string model", `{"model":42}`, ""},
		{"empty body", ``, ""},
		{"invalid json", `{oops`, ""},
	}
	for _, c := range cases {
		if got := ExtractModel([]byte(c.body)); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestGlobMatch(t *testing.T) {
	cases := []struct {
		pattern, model string
		want           bool
	}{
		{"*", "anything", true},
		{"qwen*", "qwen3.7-plus", true},
		{"qwen*", "deepseek-chat", false},
		{"glm*", "glm-5.3-flash", true},
		{"deepseek-chat", "deepseek-chat", true},
		{"deepseek-chat", "deepseek-chat-extra", false},
		{"*free", "big-pickle-free", true},
		{"QWEN*", "qwen3.7-plus", true}, // case-insensitive
		{"gpt-4*", "gpt-4o", true},
	}
	for _, c := range cases {
		if got := GlobMatch(c.pattern, c.model); got != c.want {
			t.Errorf("GlobMatch(%q,%q) = %v, want %v", c.pattern, c.model, got, c.want)
		}
	}
}

func TestMatchProvider(t *testing.T) {
	providers := []ProviderConfig{
		{ID: "zen", Name: "Zen", BaseURL: "https://x", Models: []string{"*"}, Enabled: true},
		{ID: "qwen", Name: "Qwen", BaseURL: "https://y", Models: []string{"qwen*"}, Enabled: true},
		{ID: "off", Name: "Off", BaseURL: "https://z", Models: []string{"qwen*"}, Enabled: false},
	}
	if p := MatchProvider(providers, "qwen3.7-plus"); p == nil || p.ID != "qwen" {
		t.Errorf("specific provider should win, got %+v", p)
	}
	if p := MatchProvider(providers, "gpt-4o"); p == nil || p.ID != "zen" {
		t.Errorf("catch-all should match, got %+v", p)
	}
	if p := MatchProvider(providers, ""); p != nil {
		t.Errorf("empty model should match nothing, got %+v", p)
	}
	if p := DefaultProvider(providers); p == nil || p.ID != "zen" {
		t.Errorf("default should be catch-all zen, got %+v", p)
	}
	if p := DefaultProvider(nil); p != nil {
		t.Errorf("no providers should give nil, got %+v", p)
	}
}

func TestValidateAccount(t *testing.T) {
	good := map[string]any{"id": "qwen-1", "provider": "qwen", "apiKey": "tok", "priority": float64(1)}
	acct, err := ValidateAccount(good)
	if err != nil {
		t.Fatalf("valid account rejected: %v", err)
	}
	if acct.Name != "qwen-1" {
		t.Errorf("name should default to id, got %q", acct.Name)
	}
	if acct.UseProxy != nil {
		t.Errorf("useProxy should default to nil (proxy on), got %v", *acct.UseProxy)
	}

	// useProxy: false opts out
	noProxy := map[string]any{"id": "a", "provider": "p", "apiKey": "", "priority": float64(1), "useProxy": false}
	acct, err = ValidateAccount(noProxy)
	if err != nil {
		t.Fatalf("keyless account rejected: %v", err)
	}
	if acct.UseProxy == nil || *acct.UseProxy {
		t.Error("useProxy=false should be preserved")
	}

	// missing id
	if _, err := ValidateAccount(map[string]any{"provider": "p", "apiKey": "k", "priority": float64(1)}); !IsBadRequest(err) {
		t.Error("missing id should be a bad request")
	}
	// non-string apiKey
	if _, err := ValidateAccount(map[string]any{"id": "a", "provider": "p", "apiKey": 42, "priority": float64(1)}); !IsBadRequest(err) {
		t.Error("non-string apiKey should be a bad request")
	}
	// cookies trimmed
	withCookies := map[string]any{"id": "a", "provider": "p", "apiKey": "k", "priority": float64(1), "cookies": "  c=1  "}
	acct, _ = ValidateAccount(withCookies)
	if acct.Cookies == nil || *acct.Cookies != "c=1" {
		t.Error("cookies should be trimmed")
	}
}

func TestValidateProviderInput(t *testing.T) {
	p, err := ValidateProviderInput(map[string]any{
		"id": "qwen", "name": "Qwen", "baseUrl": "https://chat.qwen.ai/",
		"models": []any{"qwen*"}, "protocol": "qwen-web",
		"qwen": map[string]any{"defaultModel": "qwen3.7-plus"},
	})
	if err != nil {
		t.Fatalf("valid provider rejected: %v", err)
	}
	if p.BaseURL != "https://chat.qwen.ai" {
		t.Errorf("baseUrl should be trimmed of trailing slash, got %q", p.BaseURL)
	}
	if p.Protocol != "qwen-web" || p.Qwen == nil || p.Qwen.DefaultModel != "qwen3.7-plus" {
		t.Errorf("qwen-web protocol not parsed: %+v", p)
	}

	// defaults: models -> ["*"], enabled true, name -> id
	p, err = ValidateProviderInput(map[string]any{"id": "x", "baseUrl": "https://example.com"})
	if err != nil {
		t.Fatalf("minimal provider rejected: %v", err)
	}
	if len(p.Models) != 1 || p.Models[0] != "*" || !p.Enabled || p.Name != "x" {
		t.Errorf("defaults wrong: %+v", p)
	}

	// bad id
	if _, err := ValidateProviderInput(map[string]any{"id": "bad id!", "baseUrl": "https://example.com"}); !IsBadRequest(err) {
		t.Error("bad id should be a bad request")
	}
	// bad url
	if _, err := ValidateProviderInput(map[string]any{"id": "x", "baseUrl": "not-a-url"}); !IsBadRequest(err) {
		t.Error("bad url should be a bad request")
	}
	// deepseek toggles
	p, err = ValidateProviderInput(map[string]any{
		"id": "ds", "baseUrl": "https://chat.deepseek.com", "protocol": "deepseek-web",
		"deepseek": map[string]any{"thinkingEnabled": true, "searchEnabled": false},
	})
	if err != nil {
		t.Fatalf("deepseek provider rejected: %v", err)
	}
	if p.DeepSeek == nil || p.DeepSeek.ThinkingEnabled == nil || !*p.DeepSeek.ThinkingEnabled {
		t.Errorf("thinkingEnabled not parsed: %+v", p.DeepSeek)
	}
}

func TestPresets(t *testing.T) {
	q := QwenPreset()
	if q.ID != "qwen" || q.Protocol != "qwen-web" || q.Qwen.DefaultModel != "qwen3.7-plus" {
		t.Errorf("bad qwen preset: %+v", q)
	}
	d := DeepSeekPreset()
	if d.Protocol != "deepseek-web" || len(d.Models) != 1 || d.Models[0] != "deepseek-chat" {
		t.Errorf("bad deepseek preset: %+v", d)
	}
	z := ZaiPreset()
	if z.Protocol != "zai-web" || !strings.HasPrefix(z.Zai.DefaultModel, "glm-") {
		t.Errorf("bad zai preset: %+v", z)
	}
}
