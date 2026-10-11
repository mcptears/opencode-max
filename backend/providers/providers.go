// Package providers manages the provider registry: loading/saving
// providers.json, normalizing entries, matching request models to providers
// via glob patterns, and the built-in Qwen/DeepSeek/Z.ai presets. It mirrors
// src/providers.ts.
package providers

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/mcptears/opencode-max/store"
	"github.com/mcptears/opencode-max/types"
)

// DefaultPath resolves the providers file: PROVIDERS_FILE wins, otherwise
// providers.json is searched upward from the working directory (up to 3
// levels, so running from backend/ still finds the repo-root file).
func DefaultPath() string {
	if p := strings.TrimSpace(os.Getenv("PROVIDERS_FILE")); p != "" {
		return p
	}
	dir, err := os.Getwd()
	if err != nil {
		return "providers.json"
	}
	for i := 0; i < 4; i++ {
		cand := filepath.Join(dir, "providers.json")
		if _, err := os.Stat(cand); err == nil {
			return cand
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	wd, _ := os.Getwd()
	return filepath.Join(wd, "providers.json")
}

var globCache sync.Map // string -> *regexp.Regexp

// GlobMatch reports whether model matches pattern, where "*" matches any run
// of characters (case-insensitive), mirroring the TypeScript globMatch.
func GlobMatch(pattern, model string) bool {
	p := strings.TrimSpace(pattern)
	if v, ok := globCache.Load(p); ok {
		return v.(*regexp.Regexp).MatchString(model)
	}
	var sb strings.Builder
	sb.WriteString("(?i)^")
	parts := strings.Split(p, "*")
	for i, part := range parts {
		if i > 0 {
			sb.WriteString(".*")
		}
		sb.WriteString(regexp.QuoteMeta(part))
	}
	sb.WriteString("$")
	re := regexp.MustCompile(sb.String())
	globCache.Store(p, re)
	return re.MatchString(model)
}

// MatchProvider returns the first enabled provider whose model globs match.
// Providers with specific patterns beat a bare "*" catch-all regardless of
// file order, so e.g. "qwen*" wins over the zen catch-all.
func MatchProvider(providers []types.ProviderConfig, model string) *types.ProviderConfig {
	if strings.TrimSpace(model) == "" {
		return nil
	}
	var specific, catchall []*types.ProviderConfig
	for i := range providers {
		p := &providers[i]
		if !p.Enabled {
			continue
		}
		if slices.Contains(p.Models, "*") {
			catchall = append(catchall, p)
		} else {
			specific = append(specific, p)
		}
	}
	for _, p := range append(specific, catchall...) {
		for _, m := range p.Models {
			if GlobMatch(m, model) {
				return p
			}
		}
	}
	return nil
}

// DefaultProvider returns the catch-all provider used when no model pattern
// matches, falling back to the first enabled provider.
func DefaultProvider(providers []types.ProviderConfig) *types.ProviderConfig {
	for i := range providers {
		if providers[i].Enabled && slices.Contains(providers[i].Models, "*") {
			return &providers[i]
		}
	}
	for i := range providers {
		if providers[i].Enabled {
			return &providers[i]
		}
	}
	return nil
}

// DefaultProviders returns the built-in default registry: a single
// OpenCode Zen catch-all provider.
func DefaultProviders(upstreamBase string) []types.ProviderConfig {
	if upstreamBase == "" {
		upstreamBase = types.DefaultUpstreamBase
	}
	return []types.ProviderConfig{
		{
			ID:      "opencode-zen",
			Name:    "OpenCode Zen",
			BaseURL: upstreamBase,
			Models:  []string{"*"},
			Enabled: true,
		},
	}
}

// Presets returns deep copies of the built-in Qwen/DeepSeek/Z.ai provider
// presets, safe for callers to mutate.
func Presets() []types.ProviderConfig {
	return []types.ProviderConfig{
		cloneProvider(types.DeepSeekPreset),
		cloneProvider(types.ZaiPreset),
		cloneProvider(types.QwenPreset),
	}
}

// PresetByID returns a deep copy of the preset with the given id
// ("deepseek", "zai" or "qwen").
func PresetByID(id string) (types.ProviderConfig, bool) {
	for _, p := range Presets() {
		if p.ID == id {
			return p, true
		}
	}
	return types.ProviderConfig{}, false
}

func cloneStringMap(m map[string]string) map[string]string {
	if m == nil {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func cloneProvider(p types.ProviderConfig) types.ProviderConfig {
	c := p
	c.Models = append([]string(nil), p.Models...)
	if p.Qwen != nil {
		q := *p.Qwen
		q.ModelMap = cloneStringMap(p.Qwen.ModelMap)
		c.Qwen = &q
	}
	if p.DeepSeek != nil {
		d := *p.DeepSeek
		d.ModelMap = cloneStringMap(p.DeepSeek.ModelMap)
		if p.DeepSeek.ThinkingEnabled != nil {
			v := *p.DeepSeek.ThinkingEnabled
			d.ThinkingEnabled = &v
		}
		if p.DeepSeek.SearchEnabled != nil {
			v := *p.DeepSeek.SearchEnabled
			d.SearchEnabled = &v
		}
		c.DeepSeek = &d
	}
	if p.Zai != nil {
		z := *p.Zai
		z.ModelMap = cloneStringMap(p.Zai.ModelMap)
		if p.Zai.ThinkingEnabled != nil {
			v := *p.Zai.ThinkingEnabled
			z.ThinkingEnabled = &v
		}
		if p.Zai.SearchEnabled != nil {
			v := *p.Zai.SearchEnabled
			z.SearchEnabled = &v
		}
		c.Zai = &z
	}
	return c
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

func strField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return strings.TrimSpace(s)
}

func strMapField(m map[string]any, key string) map[string]string {
	raw, ok := m[key].(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string)
	for k, v := range raw {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			out[k] = strings.TrimSpace(s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func boolPtrField(m map[string]any, key string) *bool {
	b, ok := m[key].(bool)
	if !ok {
		return nil
	}
	return &b
}

// Normalize validates and normalizes a decoded provider object, mirroring
// the TypeScript normalize(). It returns false for entries that must be
// dropped (missing id, missing/invalid baseUrl).
func Normalize(m map[string]any) (types.ProviderConfig, bool) {
	id := strField(m, "id")
	baseURL := strField(m, "baseUrl")
	if id == "" || baseURL == "" {
		return types.ProviderConfig{}, false
	}
	if _, err := url.ParseRequestURI(baseURL); err != nil {
		return types.ProviderConfig{}, false
	}
	baseURL = strings.TrimRight(baseURL, "/")

	var models []string
	if arr, ok := m["models"].([]any); ok {
		for _, item := range arr {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				models = append(models, s)
			}
		}
	}
	if len(models) == 0 {
		models = []string{"*"}
	}

	enabled := true
	if b, ok := m["enabled"].(bool); ok {
		enabled = b
	}

	name := strField(m, "name")
	if name == "" {
		name = id
	}

	p := types.ProviderConfig{
		ID:      id,
		Name:    name,
		BaseURL: baseURL,
		Models:  models,
		Enabled: enabled,
	}

	switch strField(m, "protocol") {
	case string(types.ProtocolQwenWeb):
		p.Protocol = types.ProtocolQwenWeb
		qm, _ := m["qwen"].(map[string]any)
		if qm == nil {
			qm = map[string]any{}
		}
		def := strField(qm, "defaultModel")
		if def == "" {
			def = "qwen3.7-plus"
		}
		p.Qwen = &types.QwenWebOptions{DefaultModel: def, ModelMap: strMapField(qm, "modelMap")}
	case string(types.ProtocolDeepSeekWeb):
		p.Protocol = types.ProtocolDeepSeekWeb
		dm, _ := m["deepseek"].(map[string]any)
		if dm == nil {
			dm = map[string]any{}
		}
		def := strField(dm, "defaultModel")
		if def == "" {
			def = "deepseek-chat"
		}
		p.DeepSeek = &types.DeepSeekWebOptions{
			DefaultModel:    def,
			ModelMap:        strMapField(dm, "modelMap"),
			ThinkingEnabled: boolPtrField(dm, "thinkingEnabled"),
			SearchEnabled:   boolPtrField(dm, "searchEnabled"),
		}
	case string(types.ProtocolZaiWeb):
		p.Protocol = types.ProtocolZaiWeb
		zm, _ := m["zai"].(map[string]any)
		if zm == nil {
			zm = map[string]any{}
		}
		def := strField(zm, "defaultModel")
		if def == "" {
			def = "glm-5"
		}
		p.Zai = &types.ZaiWebOptions{
			DefaultModel:    def,
			ModelMap:        strMapField(zm, "modelMap"),
			ThinkingEnabled: boolPtrField(zm, "thinkingEnabled"),
			SearchEnabled:   boolPtrField(zm, "searchEnabled"),
		}
	default:
		// openai (or unknown): protocol stays empty so omitempty drops it,
		// matching the TypeScript output shape.
		p.Protocol = ""
	}
	return p, true
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

// Load reads providers from path (bare array or {"providers": [...]} wrapper),
// normalizes each entry and drops invalid ones. A missing or corrupt file, or
// a file with no valid providers, falls back to DefaultProviders.
func Load(path string) ([]types.ProviderConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return DefaultProviders(types.DefaultUpstreamBase), nil
		}
		return nil, fmt.Errorf("read providers file %s: %w", path, err)
	}
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		// Corrupted file -> fall back to defaults, like the TypeScript loader.
		return DefaultProviders(types.DefaultUpstreamBase), nil
	}
	var list []any
	switch v := raw.(type) {
	case []any:
		list = v
	case map[string]any:
		if arr, ok := v["providers"].([]any); ok {
			list = arr
		}
	}
	var out []types.ProviderConfig
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if p, ok := Normalize(m); ok {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return DefaultProviders(types.DefaultUpstreamBase), nil
	}
	return out, nil
}

// Save persists providers to path as {"providers": [...]} with 0600
// permissions.
func Save(path string, providers []types.ProviderConfig) error {
	s := store.New[store.ProviderFile](path)
	return s.Save(store.ProviderFile{Providers: providers})
}
