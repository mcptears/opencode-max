package api

import (
	"context"
	"io"
	"net/http"
)

// ---------------------------------------------------------------------------
// Placeholder interfaces for packages owned by other agents.
// Method names/signatures mirror the TypeScript sources; reconcile with the
// real implementations when they land.
// ---------------------------------------------------------------------------

// AccountPool is the multi-account key pool (src/accountPool.ts).
type AccountPool interface {
	// Status returns the keyless dashboard view of every account.
	Status() []AccountStatus
	// Acquire picks the best usable account for providerID (nil if none).
	Acquire(providerID string) *AccountConfig
	// Release returns an account to the pool after a request.
	Release(id string)
	// Replace swaps the whole account list (dashboard edits).
	Replace(accounts []AccountConfig)
	// ClearInvalid re-admits a key flagged invalid.
	ClearInvalid(id string)
	// Count returns the number of accounts on a provider.
	Count(providerID string) int
	// AllInvalid reports whether every account on the provider is parked invalid.
	AllInvalid(providerID string) bool
	// NextAvailableIn returns ms until a cooling account frees up (0 = none cooling).
	NextAvailableIn(providerID string) int64
	// AtCap reports whether every usable account is at its in-flight cap.
	AtCap(providerID string) bool
	// HasCapacity reports whether any account has a free in-flight slot.
	HasCapacity(providerID string) bool
	// MarkInvalid parks a dead key until reset.
	MarkInvalid(id string)
	// MarkLimited parks an account in cooldown after 429/quota.
	MarkLimited(id string)
	// RecordLatency feeds the latency EMA for routing.
	RecordLatency(id string, ms int64)
}

// IpRotator is the egress/proxy rotator (src/ipRotator.ts).
type IpRotator interface {
	Status() RotatorStatus
	// Rotate advances to the next egress and returns its label.
	Rotate() string
	// Current returns the current proxy URL ("" = direct).
	Current() string
	// CurrentFamily returns 4 or 6 for direct egress.
	CurrentFamily() int
	SetProxies(proxies []string)
	// RoundTripperFor returns an http.RoundTripper for proxyURL ("" = direct).
	RoundTripperFor(proxyURL string, family int) http.RoundTripper
	RecordProxyResult(proxyURL string, ok bool, latencyMs int64)
	CheckProxies(proxies []string)
	StartHealthChecks(intervalMs int64)
	StopHealthChecks()
	ConfigureEgress(familyMode string)
	EgressLabel() string
}

// Metrics is the observability feed (src/metrics.ts).
type Metrics interface {
	Summary() any
	RecentEvents(n int) []any
	RecentLogRequests(n int) []any
	ClearLogs()
	History(hours int) any
	ModelStats(hours int, providerOf func(string) string) any
	UsageStats(hours int) any
	ProviderHealth(hours int, providerOf func(string) string) any
	RecentRequests(n int, providerOf func(string) string) []any
	Record(event, message string)
	Rotated(label string)
	Limited(accountID string)
	Retried()
	Failover(from, to string)
	Hit(accountID string)
	Ok()
	AddTokensSaved(n int)
	LogRequest(accountID string, status int, latencyMs int64, model string)
	LogUsage(accountID, model string, prompt, completion int)
	// Prometheus renders the /metrics exposition format.
	Prometheus() string
}

// ProviderStore persists the provider registry (src/providers.ts).
type ProviderStore interface {
	Load() []ProviderConfig
	Save(providers []ProviderConfig)
}

// SettingsStore is the live dashboard-editable settings (src/settings.ts).
type SettingsStore interface {
	Get() Settings
	// Save applies a partial patch (whitelisted keys) and returns the result.
	Save(patch map[string]any) Settings
	FilePath() string
}

// AccountStore persists accounts.json (src/store.ts).
type AccountStore interface {
	Read() []AccountConfig
	Write(accounts []AccountConfig)
}

// ProxyStore persists proxies.json (src/store.ts).
type ProxyStore interface {
	Read() []string
	Write(proxies []string)
}

// ScraperStore persists free-proxy scraper sources (src/scraper.ts).
type ScraperStore interface {
	Load() []ScraperProvider
	Save(providers []ScraperProvider)
	// TestProxy probes one proxy URL without adding it.
	TestProxy(proxyURL string) bool
}

// ScraperJob runs the background proxy scraper (src/scraperJob.ts).
type ScraperJob interface {
	Status() any
	// Start begins a scrape; returns false if one is already running.
	Start() bool
}

// ValidationResult is the outcome of a credential probe.
type ValidationResult struct {
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
	NeedCode bool   `json:"needCode,omitempty"`
}

// SignInResult is the outcome of an email+password sign-in.
type SignInResult struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	Credential string `json:"credential,omitempty"`
	Cookies    string `json:"cookies,omitempty"`
	NeedCode   bool   `json:"needCode,omitempty"`
}

// WebAuth groups the native web-provider credential flows
// (src/qwenWeb.ts, src/deepseekWeb.ts, src/zaiWeb.ts).
type WebAuth interface {
	ValidateQwen(ctx context.Context, baseURL, credential, cookies string) ValidationResult
	QwenSignIn(ctx context.Context, baseURL, email, passwordHash string) SignInResult
	ValidateDeepSeek(ctx context.Context, baseURL, credential, cookies string) ValidationResult
	DeepSeekSignIn(ctx context.Context, baseURL, email, passwordHash, verificationCode string) SignInResult
	ResendDeepSeekCode(ctx context.Context, baseURL, email string) ValidationResult
	ValidateZai(ctx context.Context, baseURL, credential string) ValidationResult
}

// ForwardRequest mirrors ForwardRequest in src/upstreamClient.ts.
type ForwardRequest struct {
	Method         string
	Path           string // path on the upstream, e.g. "/chat/completions"
	Query          string // raw query incl. leading "?", or ""
	Headers        map[string]string
	Body           []byte // nil for GET/HEAD
	Provider       string // account pool selector ("" = auto)
	AllowAnonymous bool
	Ctx            context.Context
}

// ForwardResult mirrors ForwardResult in src/upstreamClient.ts.
type ForwardResult struct {
	Status  int
	Headers map[string]string
	Body    io.ReadCloser // nil when no body
}

// ProviderExhaustedError mirrors ProviderExhaustedError: one provider can't
// serve the request; the caller should fail over to the next.
type ProviderExhaustedError struct{ Msg string }

func (e *ProviderExhaustedError) Error() string { return e.Msg }

// UpstreamClient forwards /v1 requests with account selection, retry and
// cross-provider failover (src/upstreamClient.ts).
type UpstreamClient interface {
	Forward(req ForwardRequest) (ForwardResult, error)
}

// Deps wires the api package to the rest of the process. Fill it in main.go
// once the sibling packages are implemented.
type Deps struct {
	Pool       AccountPool
	Rotator    IpRotator
	Metrics    Metrics
	Providers  ProviderStore
	Settings   SettingsStore
	Accounts   AccountStore
	Proxies    ProxyStore
	Scraper    ScraperStore
	ScraperJob ScraperJob
	WebAuth    WebAuth
	Upstream   UpstreamClient
	// ReinitFileLogger picks up logFile/rotation changes without a restart.
	ReinitFileLogger func()
}
