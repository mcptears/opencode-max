package providers

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mcptears/opencode-max/types"
)

func TestGlobMatch(t *testing.T) {
	cases := []struct {
		pattern, model string
		want           bool
	}{
		{"*", "anything-at-all", true},
		{"qwen*", "qwen3.7-plus", true},
		{"qwen*", "deepseek-chat", false},
		{"QWEN*", "qwen3.7-plus", true}, // case-insensitive
		{"qwen3.7-plus", "qwen3.7-plus", true},
		{"qwen3.7-plus", "QWEN3.7-PLUS", true},
		{"qwen3.7-plus", "qwen3.7-plusx", false},
		{"*qwen*", "xqwen3y", true},
		{"glm-5*", "glm-5.3-flash", true},
		{"glm-5*", "glm-4", false},
		{"deepseek-*", "deepseek-chat", true},
		// regex metacharacters in the pattern are literal
		{"qwen.3", "qwen.3", true},
		{"qwen.3", "qwenX3", false},
		{"qwen(3)", "qwen(3)", true},
		{"qwen(3)", "qwen3", false},
		{"  qwen*  ", "qwen3.7-plus", true}, // surrounding whitespace trimmed
	}
	for _, c := range cases {
		if got := GlobMatch(c.pattern, c.model); got != c.want {
			t.Errorf("GlobMatch(%q, %q) = %v, want %v", c.pattern, c.model, got, c.want)
		}
	}
}

func testProviders() []types.ProviderConfig {
	return []types.ProviderConfig{
		{ID: "opencode-zen", Name: "OpenCode Zen", BaseURL: "https://opencode.ai/zen/v1", Models: []string{"*"}, Enabled: true},
		{ID: "qwen", Name: "Qwen", BaseURL: "https://chat.qwen.ai", Models: []string{"qwen*"}, Enabled: true, Protocol: types.ProtocolQwenWeb},
		{ID: "off", Name: "Off", BaseURL: "https://example.com", Models: []string{"off*"}, Enabled: false},
	}
}

func TestMatchProvider(t *testing.T) {
	// Specific pattern beats the catch-all regardless of file order.
	if p := MatchProvider(testProviders(), "qwen3.7-plus"); p == nil || p.ID != "qwen" {
		t.Errorf("MatchProvider(qwen3.7-plus) = %v, want qwen", p)
	}
	if p := MatchProvider(testProviders(), "gpt-4o"); p == nil || p.ID != "opencode-zen" {
		t.Errorf("MatchProvider(gpt-4o) = %v, want opencode-zen", p)
	}
	// Disabled providers are skipped.
	if p := MatchProvider(testProviders(), "off-model"); p == nil || p.ID != "opencode-zen" {
		t.Errorf("MatchProvider(off-model) = %v, want opencode-zen (off is disabled)", p)
	}
	// Empty model matches nothing.
	if p := MatchProvider(testProviders(), ""); p != nil {
		t.Errorf("MatchProvider(\"\") = %v, want nil", p.ID)
	}
	if p := MatchProvider(testProviders(), "   "); p != nil {
		t.Errorf("MatchProvider(whitespace) = %v, want nil", p.ID)
	}
	// No providers at all.
	if p := MatchProvider(nil, "qwen3.7-plus"); p != nil {
		t.Errorf("MatchProvider(nil) = %v, want nil", p.ID)
	}
}

func TestMatchProviderCatchAllOnly(t *testing.T) {
	ps := []types.ProviderConfig{
		{ID: "zen", Models: []string{"*"}, Enabled: true},
	}
	if p := MatchProvider(ps, "whatever"); p == nil || p.ID != "zen" {
		t.Errorf("MatchProvider with only catch-all = %v, want zen", p)
	}
}

func TestDefaultProvider(t *testing.T) {
	if p := DefaultProvider(testProviders()); p == nil || p.ID != "opencode-zen" {
		t.Errorf("DefaultProvider = %v, want opencode-zen", p)
	}
	// Falls back to the first enabled provider when there is no catch-all.
	ps := []types.ProviderConfig{
		{ID: "a", Models: []string{"a*"}, Enabled: true},
		{ID: "b", Models: []string{"b*"}, Enabled: true},
	}
	if p := DefaultProvider(ps); p == nil || p.ID != "a" {
		t.Errorf("DefaultProvider without catch-all = %v, want a", p)
	}
	if p := DefaultProvider(nil); p != nil {
		t.Errorf("DefaultProvider(nil) = %v, want nil", p)
	}
}

func TestNormalize(t *testing.T) {
	// Valid openai provider.
	p, ok := Normalize(map[string]any{
		"id": "zen", "name": "Zen", "baseUrl": "https://opencode.ai/zen/v1/",
		"models": []any{"*"}, "enabled": true,
	})
	if !ok {
		t.Fatal("Normalize rejected a valid provider")
	}
	if p.BaseURL != "https://opencode.ai/zen/v1" {
		t.Errorf("trailing slash not trimmed: %q", p.BaseURL)
	}
	if p.Protocol != "" || p.EffectiveProtocol() != types.ProtocolOpenAI {
		t.Errorf("protocol = %q, want empty/openai", p.Protocol)
	}

	// Missing id / bad URL are dropped.
	if _, ok := Normalize(map[string]any{"baseUrl": "https://x.com"}); ok {
		t.Error("Normalize accepted a provider without id")
	}
	if _, ok := Normalize(map[string]any{"id": "x", "baseUrl": "not a url"}); ok {
		t.Error("Normalize accepted a provider with an invalid baseUrl")
	}

	// Defaults: models -> ["*"], enabled -> true, name -> id.
	p, ok = Normalize(map[string]any{"id": "x", "baseUrl": "https://x.com"})
	if !ok || len(p.Models) != 1 || p.Models[0] != "*" || !p.Enabled || p.Name != "x" {
		t.Errorf("defaults wrong: %+v", p)
	}
	// enabled: false is honored.
	p, _ = Normalize(map[string]any{"id": "x", "baseUrl": "https://x.com", "enabled": false})
	if p.Enabled {
		t.Error("enabled=false was not honored")
	}

	// Qwen protocol keeps options and filters the model map.
	p, ok = Normalize(map[string]any{
		"id": "qwen", "baseUrl": "https://chat.qwen.ai", "protocol": "qwen-web",
		"qwen": map[string]any{
			"defaultModel": "qwen3.7-plus",
			"modelMap":     map[string]any{"a": "b", "empty": "  ", "num": 42},
		},
	})
	if !ok || p.Protocol != types.ProtocolQwenWeb || p.Qwen == nil {
		t.Fatalf("qwen-web not parsed: %+v", p)
	}
	if p.Qwen.DefaultModel != "qwen3.7-plus" || len(p.Qwen.ModelMap) != 1 || p.Qwen.ModelMap["a"] != "b" {
		t.Errorf("qwen options wrong: %+v", p.Qwen)
	}
	// Missing qwen block still gets defaults.
	p, _ = Normalize(map[string]any{"id": "qwen", "baseUrl": "https://chat.qwen.ai", "protocol": "qwen-web"})
	if p.Qwen == nil || p.Qwen.DefaultModel != "qwen3.7-plus" {
		t.Errorf("qwen defaults wrong: %+v", p.Qwen)
	}

	// DeepSeek toggles.
	p, _ = Normalize(map[string]any{
		"id": "ds", "baseUrl": "https://chat.deepseek.com", "protocol": "deepseek-web",
		"deepseek": map[string]any{"thinkingEnabled": true, "searchEnabled": false},
	})
	if p.DeepSeek == nil || p.DeepSeek.ThinkingEnabled == nil || !*p.DeepSeek.ThinkingEnabled ||
		p.DeepSeek.SearchEnabled == nil || *p.DeepSeek.SearchEnabled {
		t.Errorf("deepseek toggles wrong: %+v", p.DeepSeek)
	}

	// Unknown protocol degrades to openai and drops web options.
	p, _ = Normalize(map[string]any{
		"id": "x", "baseUrl": "https://x.com", "protocol": "bogus",
		"qwen": map[string]any{"defaultModel": "q"},
	})
	if p.EffectiveProtocol() != types.ProtocolOpenAI || p.Qwen != nil {
		t.Errorf("unknown protocol not degraded: %+v", p)
	}
}

func TestPresets(t *testing.T) {
	ps := Presets()
	if len(ps) != 3 {
		t.Fatalf("Presets() returned %d providers, want 3", len(ps))
	}
	byID := map[string]types.ProviderConfig{}
	for _, p := range ps {
		byID[p.ID] = p
	}
	if byID["deepseek"].EffectiveProtocol() != types.ProtocolDeepSeekWeb {
		t.Error("deepseek preset has wrong protocol")
	}
	if byID["zai"].EffectiveProtocol() != types.ProtocolZaiWeb {
		t.Error("zai preset has wrong protocol")
	}
	if q := byID["qwen"]; q.EffectiveProtocol() != types.ProtocolQwenWeb ||
		q.Qwen == nil || q.Qwen.DefaultModel != "qwen3.7-plus" ||
		q.Qwen.ModelMap["qwen3.8-omni-flash"] != "qwen3.8-omni-flash" {
		t.Errorf("qwen preset wrong: %+v", q)
	}
	// Deep copies: mutating the result must not affect the package vars.
	ps[0].Models[0] = "mutated"
	ps[0].DeepSeek.ModelMap["deepseek-chat"] = "mutated"
	if types.DeepSeekPreset.Models[0] != "deepseek-chat" ||
		types.DeepSeekPreset.DeepSeek.ModelMap["deepseek-chat"] != "deepseek-chat" {
		t.Error("Presets() did not return deep copies")
	}
	if _, ok := PresetByID("zai"); !ok {
		t.Error("PresetByID(zai) not found")
	}
	if _, ok := PresetByID("nope"); ok {
		t.Error("PresetByID(nope) should not be found")
	}
}

func TestLoadSaveRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "providers.json")
	original := []types.ProviderConfig{
		{ID: "zen", Name: "Zen", BaseURL: "https://opencode.ai/zen/v1", Models: []string{"*"}, Enabled: true},
		types.QwenPreset,
	}
	if err := Save(path, original); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded) != 2 || loaded[0].ID != "zen" || loaded[1].ID != "qwen" {
		t.Fatalf("round trip mismatch: %+v", loaded)
	}
	if loaded[1].Qwen == nil || loaded[1].Qwen.ModelMap["qwen3.7-plus"] != "qwen3.7-plus" {
		t.Errorf("qwen options lost in round trip: %+v", loaded[1].Qwen)
	}
	// File must be 0600.
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("providers.json perms = %o, want 600", fi.Mode().Perm())
	}
}

func TestLoadMissingAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	// Missing -> defaults.
	ps, err := Load(filepath.Join(dir, "nope.json"))
	if err != nil {
		t.Fatalf("Load missing: %v", err)
	}
	if len(ps) != 1 || ps[0].ID != "opencode-zen" {
		t.Errorf("missing file did not yield defaults: %+v", ps)
	}
	// Corrupt -> defaults (TypeScript behavior).
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	ps, err = Load(bad)
	if err != nil {
		t.Fatalf("Load corrupt: %v", err)
	}
	if len(ps) != 1 || ps[0].ID != "opencode-zen" {
		t.Errorf("corrupt file did not yield defaults: %+v", ps)
	}
	// All entries invalid -> defaults.
	none := filepath.Join(dir, "none.json")
	if err := os.WriteFile(none, []byte(`[{"id":"","baseUrl":"https://x.com"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	ps, err = Load(none)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(ps) != 1 || ps[0].ID != "opencode-zen" {
		t.Errorf("no valid entries did not yield defaults: %+v", ps)
	}
	// Bare array form (no wrapper) is accepted.
	arr := filepath.Join(dir, "arr.json")
	if err := os.WriteFile(arr, []byte(`[{"id":"c","baseUrl":"https://c.example.com","models":["c*"]}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	ps, err = Load(arr)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(ps) != 1 || ps[0].ID != "c" {
		t.Errorf("bare array not loaded: %+v", ps)
	}
}
