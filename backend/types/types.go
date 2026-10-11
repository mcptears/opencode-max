// Package types holds the core data models shared by every backend package.
// Field names and JSON tags mirror the TypeScript sources in src/ so the Go
// backend reads and writes the same accounts.json, providers.json,
// proxies.json and settings.json files.
package types

// DefaultUpstreamBase is the OpenCode Zen base URL used when no
// UPSTREAM_BASE env var (or settings override) is configured.
const DefaultUpstreamBase = "https://opencode.ai/zen/v1"

// AccountConfig is a single upstream credential in the account pool.
type AccountConfig struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Provider is the provider pool this account belongs to, e.g. "opencode-zen".
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey"`
	// Priority: 1 = highest. Lower-priority accounts are used when higher
	// ones cool down.
	Priority int `json:"priority"`
	// Cookies holds optional session cookies (e.g. DeepSeek web chat needs
	// these plus the token).
	Cookies string `json:"cookies,omitempty"`
	// DeviceToken is the Aliyun device fingerprint for Z.ai accounts
	// (window.z_um.getToken() in the browser at chat.z.ai), used to generate
	// captcha_verify_param for each request.
	DeviceToken string `json:"deviceToken,omitempty"`
	// UseProxy: when false the account connects directly without a proxy.
	// Nil (absent) preserves the legacy default of true.
	UseProxy *bool `json:"useProxy,omitempty"`
	// CooldownPeriod is how long (ms) the account stays parked after a
	// 429/quota hit. Zero means use the global default.
	CooldownPeriod int64 `json:"cooldownPeriod,omitempty"`
	// BaseURL is an optional per-account upstream override.
	BaseURL string `json:"baseUrl,omitempty"`
	// QuotaLimit is an optional per-account rolling 5h request budget.
	QuotaLimit int `json:"quotaLimit,omitempty"`
}

// ProxyEnabled reports whether the account should route through the proxy
// pool. Absent (nil) means true, preserving legacy behavior.
func (a AccountConfig) ProxyEnabled() bool {
	return a.UseProxy == nil || *a.UseProxy
}

// RuntimeConfig is the process-level configuration loaded from env vars.
type RuntimeConfig struct {
	Port              int    `json:"port"`
	UpstreamBase      string `json:"upstreamBase"`
	AccountsFile      string `json:"accountsFile"`
	ProxiesFile       string `json:"proxiesFile"`
	MaxRetries        int    `json:"maxRetries"`
	RetryBaseMs       int64  `json:"retryBaseMs"`
	RetryMaxMs        int64  `json:"retryMaxMs"`
	DefaultCooldownMs int64  `json:"defaultCooldownMs"`
	RequestTimeoutMs  int64  `json:"requestTimeoutMs"`
}

// Protocol selects how a provider talks to its upstream.
type Protocol string

const (
	// ProtocolOpenAI forwards OpenAI-format requests untouched (default).
	ProtocolOpenAI Protocol = "openai"
	// ProtocolQwenWeb speaks Qwen's private web API natively.
	ProtocolQwenWeb Protocol = "qwen-web"
	// ProtocolDeepSeekWeb speaks DeepSeek's private web API natively.
	ProtocolDeepSeekWeb Protocol = "deepseek-web"
	// ProtocolZaiWeb speaks Z.ai's private web API natively.
	ProtocolZaiWeb Protocol = "zai-web"
)

// QwenWebOptions tunes the native Qwen web provider.
type QwenWebOptions struct {
	// DefaultModel is the Qwen web model id used when the request model has
	// no mapping.
	DefaultModel string `json:"defaultModel"`
	// ModelMap maps opencode-max model names to Qwen web model ids.
	ModelMap map[string]string `json:"modelMap,omitempty"`
}

// DeepSeekWebOptions tunes the native DeepSeek web provider.
type DeepSeekWebOptions struct {
	DefaultModel string `json:"defaultModel"`
	// ModelMap maps opencode-max model names to DeepSeek web model ids.
	ModelMap map[string]string `json:"modelMap,omitempty"`
	// ThinkingEnabled is the default DeepThink (reasoning) state.
	ThinkingEnabled *bool `json:"thinkingEnabled,omitempty"`
	// SearchEnabled is the default web-search state.
	SearchEnabled *bool `json:"searchEnabled,omitempty"`
}

// ZaiWebOptions tunes the native Z.ai web provider.
type ZaiWebOptions struct {
	DefaultModel string `json:"defaultModel"`
	// ModelMap maps opencode-max model names to Z.ai web model ids.
	ModelMap map[string]string `json:"modelMap,omitempty"`
	// ThinkingEnabled is the default thinking state.
	ThinkingEnabled *bool `json:"thinkingEnabled,omitempty"`
	// SearchEnabled is the default web-search state.
	SearchEnabled *bool `json:"searchEnabled,omitempty"`
}

// ProviderConfig describes one upstream provider pool.
type ProviderConfig struct {
	// ID is the stable id, e.g. "opencode-zen". Accounts reference it.
	ID   string `json:"id"`
	Name string `json:"name"`
	// BaseURL is the OpenAI-compatible base URL.
	BaseURL string `json:"baseUrl"`
	// Models are glob patterns matched against the request model, in order.
	// "*" is the catch-all.
	Models  []string `json:"models"`
	Enabled bool     `json:"enabled"`
	// Protocol selects the upstream wire protocol. Empty means openai.
	Protocol Protocol `json:"protocol,omitempty"`
	// Qwen holds Qwen web options (only used with ProtocolQwenWeb).
	Qwen *QwenWebOptions `json:"qwen,omitempty"`
	// DeepSeek holds DeepSeek web options (only used with ProtocolDeepSeekWeb).
	DeepSeek *DeepSeekWebOptions `json:"deepseek,omitempty"`
	// Zai holds Z.ai web options (only used with ProtocolZaiWeb).
	Zai *ZaiWebOptions `json:"zai,omitempty"`
}

// EffectiveProtocol returns the wire protocol, defaulting to openai when
// unset.
func (p ProviderConfig) EffectiveProtocol() Protocol {
	switch p.Protocol {
	case ProtocolQwenWeb, ProtocolDeepSeekWeb, ProtocolZaiWeb:
		return p.Protocol
	default:
		return ProtocolOpenAI
	}
}

// EgressFamily selects the direct-egress IP family.
type EgressFamily string

const (
	EgressAuto EgressFamily = "auto"
	EgressV4   EgressFamily = "4"
	EgressV6   EgressFamily = "6"
)

// RoutingStrategy selects how the pool picks accounts.
type RoutingStrategy string

const (
	RoutingPriority RoutingStrategy = "priority"
	RoutingLatency  RoutingStrategy = "latency"
)

// Settings is the full dashboard-editable configuration persisted to
// settings.json.
type Settings struct {
	Port              int    `json:"port"`
	UpstreamBase      string `json:"upstreamBase"`
	MaxRetries        int    `json:"maxRetries"`
	RetryBaseMs       int64  `json:"retryBaseMs"`
	RetryMaxMs        int64  `json:"retryMaxMs"`
	DefaultCooldownMs int64  `json:"defaultCooldownMs"`
	RequestTimeoutMs  int64  `json:"requestTimeoutMs"`
	// AdminToken guards mutating admin endpoints. Empty = open on loopback.
	AdminToken string `json:"adminToken"`
	// ProxyHealthCheck enables periodic proxy health probing.
	ProxyHealthCheck      bool  `json:"proxyHealthCheck"`
	ProxyHealthIntervalMs int64 `json:"proxyHealthIntervalMs"`
	// EgressFamily: direct-egress IP family ('auto' alternates v4/v6).
	EgressFamily EgressFamily `json:"egressFamily"`
	// Quota5hLimit is the rolling 5h request budget per account.
	Quota5hLimit int `json:"quota5hLimit"`
	// TokenSaver compresses bloated tool_result payloads before forwarding.
	TokenSaver         bool  `json:"tokenSaver"`
	TokenSaverMaxChars int64 `json:"tokenSaverMaxChars"`
	// AutoScrape periodically re-scrapes free proxy providers.
	AutoScrape              bool  `json:"autoScrape"`
	AutoScrapeIntervalHours int64 `json:"autoScrapeIntervalHours"`
	// RoutingStrategy: 'priority' (P1 first) or 'latency' (fastest first).
	RoutingStrategy RoutingStrategy `json:"routingStrategy"`
	// QueueMaxWaitMs bounds waiting for a cooling account.
	QueueMaxWaitMs int64 `json:"queueMaxWaitMs"`
	// AlertWebhookUrl is POSTed on dead keys / pool exhaustion.
	AlertWebhookUrl string `json:"alertWebhookUrl"`
	// AccountConcurrency caps parallel in-flight requests per account
	// (0 = unlimited).
	AccountConcurrency int `json:"accountConcurrency"`
	// ProxyAutoDropFails drops a proxy after this many consecutive
	// real-request failures (0 = off).
	ProxyAutoDropFails int `json:"proxyAutoDropFails"`
	// ModelFallbacks chains: when a model is exhausted everywhere, try
	// these in order.
	ModelFallbacks map[string][]string `json:"modelFallbacks"`
	// ErrorSpikeThreshold is the recent error rate (0-1) that triggers a
	// webhook alert.
	ErrorSpikeThreshold   float64 `json:"errorSpikeThreshold"`
	ErrorSpikeWindowMin   int64   `json:"errorSpikeWindowMin"`
	ErrorSpikeMinRequests int     `json:"errorSpikeMinRequests"`
	// ClientTokens guard /v1/* (empty = no auth required).
	ClientTokens []string `json:"clientTokens"`
	// ModelTimeouts maps exact model names or glob patterns to upstream
	// timeouts in ms.
	ModelTimeouts map[string]int64 `json:"modelTimeouts"`
	// LogFile mirrors console output to a file (empty = stdout only).
	LogFile  string `json:"logFile"`
	LogMaxMb int64  `json:"logMaxMb"`
	LogKeep  int    `json:"logKeep"`
	// ShutdownDrainMs bounds graceful shutdown on SIGTERM/SIGINT.
	ShutdownDrainMs int64 `json:"shutdownDrainMs"`
}

// DeepSeekPreset is the one-click native DeepSeek web provider.
var DeepSeekPreset = ProviderConfig{
	ID:       "deepseek",
	Name:     "DeepSeek (built-in)",
	BaseURL:  "https://chat.deepseek.com",
	Models:   []string{"deepseek-chat"},
	Enabled:  true,
	Protocol: ProtocolDeepSeekWeb,
	DeepSeek: &DeepSeekWebOptions{
		DefaultModel: "deepseek-chat",
		ModelMap: map[string]string{
			"deepseek-chat": "deepseek-chat",
		},
	},
}

// ZaiPreset is the one-click native Z.ai web provider.
var ZaiPreset = ProviderConfig{
	ID:       "zai",
	Name:     "Z.ai (built-in)",
	BaseURL:  "https://chat.z.ai",
	Models:   []string{"glm*"},
	Enabled:  true,
	Protocol: ProtocolZaiWeb,
	Zai: &ZaiWebOptions{
		DefaultModel: "glm-5.3-flash",
		ModelMap: map[string]string{
			"glm-5.3-flash": "glm-5.3-flash",
			"glm-5.3":       "glm-5.3",
			"glm-5.2":       "glm-5.2",
		},
	},
}

// QwenPreset is the one-click native Qwen web provider.
var QwenPreset = ProviderConfig{
	ID:       "qwen",
	Name:     "Qwen (built-in)",
	BaseURL:  "https://chat.qwen.ai",
	Models:   []string{"qwen*"},
	Enabled:  true,
	Protocol: ProtocolQwenWeb,
	Qwen: &QwenWebOptions{
		DefaultModel: "qwen3.7-plus",
		ModelMap: map[string]string{
			"qwen3.7-plus":       "qwen3.7-plus",
			"qwen3.8-max":        "qwen3.8-max",
			"qwen3.8-omni-flash": "qwen3.8-omni-flash",
		},
	},
}
