// Package api implements the opencode-max HTTP layer: the /v1/* proxy routes,
// the /api/* admin routes, and the dashboard playground endpoint.
//
// The surrounding packages (pool, proxy rotator, store, metrics, web
// providers) are owned by other agents; this package depends on them only
// through the placeholder interfaces in deps.go so it builds standalone.
// Reconcile the interfaces with the real implementations when they land.
package api

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

// ---------------------------------------------------------------------------
// Core types (mirror src/config.ts, src/providers.ts, src/settings.ts)
// ---------------------------------------------------------------------------

// AccountConfig is one upstream credential in the pool.
type AccountConfig struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey"`
	Priority int    `json:"priority"`
	// Optional session cookies (e.g. DeepSeek web chat needs these + the token).
	Cookies *string `json:"cookies,omitempty"`
	// Nil = default (proxy on, legacy); false = connect directly, no proxy.
	UseProxy *bool `json:"useProxy,omitempty"`
	// ProxyMode: "" legacy, "off" direct, "pool" round-robin, "single" pinned.
	ProxyMode string `json:"proxyMode,omitempty"`
	// ProxyURL is the pinned proxy for mode "single" (full URL, internal only).
	ProxyURL string `json:"proxyUrl,omitempty"`
	// Ms the account stays parked after a 429/quota hit.
	CooldownPeriod *int64 `json:"cooldownPeriod,omitempty"`
	// Optional per-account upstream override.
	BaseURL *string `json:"baseUrl,omitempty"`
	// Optional per-account rolling 5h request budget.
	QuotaLimit *int `json:"quotaLimit,omitempty"`
}

// AccountStatus is the keyless status view exposed to the dashboard.
type AccountStatus struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Provider       string  `json:"provider"`
	Priority       int     `json:"priority"`
	UseProxy       *bool   `json:"useProxy,omitempty"`
	ProxyMode      string  `json:"proxyMode,omitempty"` // effective: off | pool | single
	ProxyURL       string  `json:"proxyUrl,omitempty"`  // redacted when mode is single, "" otherwise
	State          string  `json:"state"` // active | cooling_down | invalid
	CooldownEndsIn int64   `json:"cooldownEndsInMs"`
	Usage5h        int     `json:"usage5h"`
	QuotaLimit     *int    `json:"quotaLimit,omitempty"`
	CooldownPeriod *int64  `json:"cooldownPeriod,omitempty"`
	BaseURL        *string `json:"baseUrl,omitempty"`
	AvgLatencyMs   float64 `json:"avgLatencyMs"`
	Inflight       int     `json:"inflight"`
}

type QwenWebOptions struct {
	DefaultModel string            `json:"defaultModel"`
	ModelMap     map[string]string `json:"modelMap,omitempty"`
}

type DeepSeekWebOptions struct {
	DefaultModel    string            `json:"defaultModel"`
	ModelMap        map[string]string `json:"modelMap,omitempty"`
	ThinkingEnabled *bool             `json:"thinkingEnabled,omitempty"`
	SearchEnabled   *bool             `json:"searchEnabled,omitempty"`
}

type ZaiWebOptions struct {
	DefaultModel    string            `json:"defaultModel"`
	ModelMap        map[string]string `json:"modelMap,omitempty"`
	ThinkingEnabled *bool             `json:"thinkingEnabled,omitempty"`
	SearchEnabled   *bool             `json:"searchEnabled,omitempty"`
}

// ProviderConfig is one upstream provider (OpenAI-compatible or native web).
type ProviderConfig struct {
	ID       string              `json:"id"`
	Name     string              `json:"name"`
	BaseURL  string              `json:"baseUrl"`
	Models   []string            `json:"models"`
	Enabled  bool                `json:"enabled"`
	Protocol string              `json:"protocol,omitempty"` // openai | qwen-web | deepseek-web | zai-web
	Qwen     *QwenWebOptions     `json:"qwen,omitempty"`
	DeepSeek *DeepSeekWebOptions `json:"deepseek,omitempty"`
	Zai      *ZaiWebOptions      `json:"zai,omitempty"`
}

// Settings mirrors the dashboard-editable runtime settings.
type Settings struct {
	Port                    int                 `json:"port"`
	UpstreamBase            string              `json:"upstreamBase"`
	MaxRetries              int                 `json:"maxRetries"`
	RetryBaseMs             int64               `json:"retryBaseMs"`
	RetryMaxMs              int64               `json:"retryMaxMs"`
	DefaultCooldownMs       int64               `json:"defaultCooldownMs"`
	RequestTimeoutMs        int64               `json:"requestTimeoutMs"`
	AdminToken              string              `json:"adminToken"`
	ProxyHealthCheck        bool                `json:"proxyHealthCheck"`
	ProxyHealthIntervalMs   int64               `json:"proxyHealthIntervalMs"`
	EgressFamily            string              `json:"egressFamily"` // auto | 4 | 6
	Quota5hLimit            int                 `json:"quota5hLimit"`
	TokenSaver              bool                `json:"tokenSaver"`
	TokenSaverMaxChars      int                 `json:"tokenSaverMaxChars"`
	AutoScrape              bool                `json:"autoScrape"`
	AutoScrapeIntervalHours float64             `json:"autoScrapeIntervalHours"`
	RoutingStrategy         string              `json:"routingStrategy"` // priority | latency
	QueueMaxWaitMs          int64               `json:"queueMaxWaitMs"`
	AlertWebhookUrl         string              `json:"alertWebhookUrl"`
	AccountConcurrency      int                 `json:"accountConcurrency"`
	ProxyAutoDropFails      int                 `json:"proxyAutoDropFails"`
	ModelFallbacks          map[string][]string `json:"modelFallbacks"`
	ErrorSpikeThreshold     float64             `json:"errorSpikeThreshold"`
	ErrorSpikeWindowMin     int                 `json:"errorSpikeWindowMin"`
	ErrorSpikeMinRequests   int                 `json:"errorSpikeMinRequests"`
	ClientTokens            []string            `json:"clientTokens"`
	ModelTimeouts           map[string]int64    `json:"modelTimeouts"`
	LogFile                 string              `json:"logFile"`
	LogMaxMb                int                 `json:"logMaxMb"`
	LogKeep                 int                 `json:"logKeep"`
	ShutdownDrainMs         int64               `json:"shutdownDrainMs"`
}

// ScraperProvider is one free-proxy list source for the scraper tab.
type ScraperProvider struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	Format  string `json:"format"` // text | geonode | spys | fpl | proxynova
	Enabled bool   `json:"enabled"`
}

// ProxyHealth is one proxy's health probe result.
type ProxyHealth struct {
	Proxy   string `json:"proxy"`
	Healthy bool   `json:"healthy"`
}

// RotatorStatus mirrors IpRotator.status().
type RotatorStatus struct {
	Proxies      int           `json:"proxies"`
	CurrentIndex int           `json:"currentIndex"`
	Current      *string       `json:"current"`
	Rotations    int           `json:"rotations"`
	Family       int           `json:"family"`
	FamilyMode   string        `json:"familyMode"`
	DualStack    bool          `json:"dualStack"`
	Health       []ProxyHealth `json:"health"`
}

// ---------------------------------------------------------------------------
// Provider presets (one-click built-ins)
// ---------------------------------------------------------------------------

// QwenPreset returns the native Qwen web provider preset.
func QwenPreset() ProviderConfig {
	return ProviderConfig{
		ID: "qwen", Name: "Qwen (built-in)", BaseURL: "https://chat.qwen.ai",
		Models: []string{"qwen*"}, Enabled: true, Protocol: "qwen-web",
		Qwen: &QwenWebOptions{
			DefaultModel: "qwen3.7-plus",
			ModelMap: map[string]string{
				"qwen3.7-plus":       "qwen3.7-plus",
				"qwen3.8-max":        "qwen3.8-max",
				"qwen3.8-omni-flash": "qwen3.8-omni-flash",
			},
		},
	}
}

// DeepSeekPreset returns the native DeepSeek web provider preset.
func DeepSeekPreset() ProviderConfig {
	return ProviderConfig{
		ID: "deepseek", Name: "DeepSeek (built-in)", BaseURL: "https://chat.deepseek.com",
		Models: []string{"deepseek-chat"}, Enabled: true, Protocol: "deepseek-web",
		DeepSeek: &DeepSeekWebOptions{
			DefaultModel: "deepseek-chat",
			ModelMap:     map[string]string{"deepseek-chat": "deepseek-chat"},
		},
	}
}

// ZaiPreset returns the native Z.ai web provider preset.
func ZaiPreset() ProviderConfig {
	return ProviderConfig{
		ID: "zai", Name: "Z.ai (built-in)", BaseURL: "https://chat.z.ai",
		Models: []string{"glm*"}, Enabled: true, Protocol: "zai-web",
		Zai: &ZaiWebOptions{
			DefaultModel: "glm-5.3-flash",
			ModelMap: map[string]string{
				"glm-5.3-flash": "glm-5.3-flash",
				"glm-5.3":       "glm-5.3",
				"glm-5.2":       "glm-5.2",
			},
		},
	}
}

// ---------------------------------------------------------------------------
// Pure helpers (fully implemented — no deps)
// ---------------------------------------------------------------------------

// ExtractModel pulls the model id out of a JSON request body.
func ExtractModel(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var parsed struct {
		Model *string `json:"model"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ""
	}
	if parsed.Model == nil {
		return ""
	}
	return *parsed.Model
}

// GlobMatch matches a model name against a glob pattern (`*` = any run,
// case-insensitive), mirroring the TypeScript globMatch.
func GlobMatch(pattern, model string) bool {
	parts := strings.Split(strings.TrimSpace(pattern), "*")
	var b strings.Builder
	b.WriteString("(?i)^")
	for i, p := range parts {
		if i > 0 {
			b.WriteString(".*")
		}
		b.WriteString(regexp.QuoteMeta(p))
	}
	b.WriteString("$")
	rx, err := regexp.Compile(b.String())
	if err != nil {
		return false
	}
	return rx.MatchString(model)
}

// MatchProvider finds the first enabled provider whose model globs match.
// Specific (non-`*`) providers win over catch-alls, mirroring matchProvider.
func MatchProvider(providers []ProviderConfig, model string) *ProviderConfig {
	if model == "" {
		return nil
	}
	ordered := make([]ProviderConfig, 0, len(providers))
	for _, p := range providers {
		if !p.Enabled {
			continue
		}
		hasStar := false
		for _, m := range p.Models {
			if m == "*" {
				hasStar = true
				break
			}
		}
		if !hasStar {
			ordered = append(ordered, p)
		}
	}
	for _, p := range providers {
		if !p.Enabled {
			continue
		}
		for _, m := range p.Models {
			if m == "*" {
				ordered = append(ordered, p)
				break
			}
		}
	}
	for i := range ordered {
		for _, m := range ordered[i].Models {
			if GlobMatch(m, model) {
				return &ordered[i]
			}
		}
	}
	return nil
}

// DefaultProvider returns the first enabled catch-all provider, else the first
// enabled provider, else nil.
func DefaultProvider(providers []ProviderConfig) *ProviderConfig {
	for i := range providers {
		if !providers[i].Enabled {
			continue
		}
		for _, m := range providers[i].Models {
			if m == "*" {
				return &providers[i]
			}
		}
	}
	for i := range providers {
		if providers[i].Enabled {
			return &providers[i]
		}
	}
	return nil
}

// strptr helpers for optional fields.
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	c := s
	return &c
}

func boolPtr(b bool) *bool {
	c := b
	return &c
}

// ValidateAccount mirrors validateAccount() in adminRoutes.ts: id, provider,
// priority required; apiKey must be a string (empty allowed for keyless).
func ValidateAccount(body map[string]any) (AccountConfig, error) {
	str := func(k string) string {
		v, _ := body[k].(string)
		return strings.TrimSpace(v)
	}
	id := str("id")
	if id == "" {
		return AccountConfig{}, errBad("id is required")
	}
	provider := str("provider")
	if provider == "" {
		return AccountConfig{}, errBad("provider is required")
	}
	apiKeyRaw, hasKey := body["apiKey"]
	if !hasKey {
		return AccountConfig{}, errBad("apiKey must be a string")
	}
	apiKey, ok := apiKeyRaw.(string)
	if !ok {
		return AccountConfig{}, errBad("apiKey must be a string")
	}
	priorityRaw, hasPriority := body["priority"]
	priority, ok := toFloat(priorityRaw)
	if !ok && hasPriority {
		return AccountConfig{}, errBad("priority must be a number")
	}
	name := str("name")
	if name == "" {
		name = id
	}
	acct := AccountConfig{
		ID: id, Name: name, Provider: provider,
		APIKey: strings.TrimSpace(apiKey), Priority: int(priority),
		Cookies: strPtr(str("cookies")),
	}
	// useProxy: false opts out (direct); anything else = default (proxy on).
	// proxyMode, when present, wins and is kept in sync with useProxy.
	if mode, ok := body["proxyMode"].(string); ok && strings.TrimSpace(mode) != "" {
		mode = strings.TrimSpace(mode)
		switch mode {
		case "off", "pool", "single":
			acct.ProxyMode = mode
			if mode == "off" {
				acct.UseProxy = boolPtr(false)
			} else {
				acct.UseProxy = nil
			}
			if mode == "single" {
				proxyURL := str("proxyUrl")
				if proxyURL == "" {
					return AccountConfig{}, errBad("proxyUrl is required for proxyMode \"single\"")
				}
				acct.ProxyURL = proxyURL
			}
		default:
			return AccountConfig{}, errBad("proxyMode must be off, pool, or single")
		}
	} else if up, ok := body["useProxy"].(bool); ok && !up {
		acct.UseProxy = boolPtr(false)
	}
	if cp, ok := toFloat(body["cooldownPeriod"]); ok && cp > 0 {
		v := int64(cp)
		acct.CooldownPeriod = &v
	}
	acct.BaseURL = strPtr(str("baseUrl"))
	if ql, ok := toFloat(body["quotaLimit"]); ok && ql > 0 {
		v := int(ql)
		acct.QuotaLimit = &v
	}
	return acct, nil
}

// ValidateProviderInput mirrors validateProviderInput() in adminRoutes.ts.
func ValidateProviderInput(body map[string]any) (ProviderConfig, error) {
	str := func(k string) string {
		v, _ := body[k].(string)
		return strings.TrimSpace(v)
	}
	id := str("id")
	if id == "" {
		return ProviderConfig{}, errBad("id is required")
	}
	if ok, _ := regexp.MatchString(`^[a-z0-9][a-z0-9-_]*$`, strings.ToLower(id)); !ok {
		return ProviderConfig{}, errBad("id must be alphanumeric with dashes/underscores")
	}
	baseURL := strings.TrimRight(str("baseUrl"), "/")
	if baseURL == "" {
		return ProviderConfig{}, errBad("baseUrl is required")
	}
	if _, err := url.ParseRequestURI(baseURL); err != nil {
		return ProviderConfig{}, errBad("baseUrl is not a valid URL")
	}
	var models []string
	if raw, ok := body["models"].([]any); ok {
		for _, m := range raw {
			if s, ok := m.(string); ok && strings.TrimSpace(s) != "" {
				models = append(models, strings.TrimSpace(s))
			}
		}
	}
	if len(models) == 0 {
		models = []string{"*"}
	}
	enabled := true
	if e, ok := body["enabled"].(bool); ok {
		enabled = e
	}
	name := str("name")
	if name == "" {
		name = id
	}
	p := ProviderConfig{ID: id, Name: name, BaseURL: baseURL, Models: models, Enabled: enabled}
	protocol, _ := body["protocol"].(string)
	sub := func(key string) map[string]any {
		m, _ := body[key].(map[string]any)
		if m == nil {
			return map[string]any{}
		}
		return m
	}
	modelMapOf := func(m map[string]any) map[string]string {
		out := map[string]string{}
		if raw, ok := m["modelMap"].(map[string]any); ok {
			for k, v := range raw {
				if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
					out[k] = strings.TrimSpace(s)
				}
			}
		}
		return out
	}
	switch protocol {
	case "qwen-web":
		q := sub("qwen")
		dm := strOf(q, "defaultModel")
		if dm == "" {
			dm = "qwen3.7-plus"
		}
		opts := &QwenWebOptions{DefaultModel: dm}
		if mm := modelMapOf(q); len(mm) > 0 {
			opts.ModelMap = mm
		}
		p.Protocol = "qwen-web"
		p.Qwen = opts
	case "deepseek-web":
		q := sub("deepseek")
		dm := strOf(q, "defaultModel")
		if dm == "" {
			dm = "deepseek-chat"
		}
		opts := &DeepSeekWebOptions{DefaultModel: dm}
		if mm := modelMapOf(q); len(mm) > 0 {
			opts.ModelMap = mm
		}
		if b, ok := q["thinkingEnabled"].(bool); ok {
			opts.ThinkingEnabled = boolPtr(b)
		}
		if b, ok := q["searchEnabled"].(bool); ok {
			opts.SearchEnabled = boolPtr(b)
		}
		p.Protocol = "deepseek-web"
		p.DeepSeek = opts
	case "zai-web":
		q := sub("zai")
		dm := strOf(q, "defaultModel")
		if dm == "" {
			dm = "glm-5"
		}
		opts := &ZaiWebOptions{DefaultModel: dm}
		if mm := modelMapOf(q); len(mm) > 0 {
			opts.ModelMap = mm
		}
		if b, ok := q["thinkingEnabled"].(bool); ok {
			opts.ThinkingEnabled = boolPtr(b)
		}
		if b, ok := q["searchEnabled"].(bool); ok {
			opts.SearchEnabled = boolPtr(b)
		}
		p.Protocol = "zai-web"
		p.Zai = opts
	}
	return p, nil
}

func strOf(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return strings.TrimSpace(v)
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

type badError struct{ msg string }

func (e *badError) Error() string { return e.msg }

func errBad(msg string) error { return &badError{msg} }

// IsBadRequest reports whether err came from ValidateAccount/ValidateProviderInput.
func IsBadRequest(err error) bool {
	_, ok := err.(*badError)
	return ok
}
