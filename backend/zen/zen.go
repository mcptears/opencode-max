// Package zen holds the OpenCode Zen / Console gateway details shared by the
// proxy, provider registry and admin validation paths.
//
// Zen is an OpenAI/Anthropic/Gemini-compatible gateway. Pay-as-you-go
// (Console) and OpenCode Go are served from different base URLs:
//
//	Console: https://opencode.ai/inference
//	Go:      https://opencode.ai/inference/go
//
// The legacy https://opencode.ai/zen/v1 prefix is obsolete and is migrated on
// load so existing configs keep working.
//
// This package intentionally contains no networking code so both the wire and
// API layers can depend on it without cycles.
package zen

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	// UserAgent identifies opencode-max. Never impersonate the official
	// OpenCode client: free-tier chat models are reserved for OpenCode and
	// other clients are expected to identify themselves.
	UserAgent = "opencode-max/1.0"

	// ConsoleBase is the pay-as-you-go / Console gateway root.
	ConsoleBase = "https://opencode.ai/inference"
	// GoBase is the OpenCode Go gateway root.
	GoBase = "https://opencode.ai/inference/go"

	// LegacyConsoleBase and LegacyGoBase are the obsolete Zen prefixes.
	LegacyConsoleBase = "https://opencode.ai/zen/v1"
	LegacyGoBase      = "https://opencode.ai/zen/go/v1"

	// API-family paths appended to a gateway root.
	ChatPath      = "/openai/v1/chat/completions"
	ResponsesPath = "/openai/v1/responses"
	MessagesPath  = "/anthropic/v1/messages"
	ModelsPath    = "/v1/models"
)

// Plan selects which Zen gateway a request is billed against.
type Plan string

const (
	PlanConsole Plan = "console"
	PlanGo      Plan = "go"
)

// NormalizePlan maps user input to a known plan. Unknown values return "" so
// callers can fall back to the provider/global default.
func NormalizePlan(s string) Plan {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "go", "go-plus", "goplus", "go_plus", "teams", "go-teams":
		return PlanGo
	case "console", "payg", "pay-as-you-go", "pay_as_you_go", "balance":
		return PlanConsole
	default:
		return ""
	}
}

// NormalizeBase canonicalizes a gateway base URL: legacy Zen prefixes migrate
// to the current Console/Go roots and trailing slashes are removed. Non-Zen
// URLs are only trimmed.
func NormalizeBase(base string) string {
	b := strings.TrimRight(strings.TrimSpace(base), "/")
	lower := strings.ToLower(b)
	switch {
	case lower == strings.ToLower(LegacyGoBase), lower == "https://opencode.ai/zen/go":
		return GoBase
	case lower == strings.ToLower(LegacyConsoleBase), lower == "https://opencode.ai/zen":
		return ConsoleBase
	}
	return b
}

// IsGateway reports whether base points at an OpenCode Zen/Console gateway.
func IsGateway(base string) bool {
	b := strings.ToLower(NormalizeBase(base))
	if !strings.HasPrefix(b, "https://opencode.ai/") {
		return false
	}
	rest := strings.TrimPrefix(b, "https://opencode.ai")
	return strings.HasPrefix(rest, "/inference") || strings.HasPrefix(rest, "/zen")
}

// PlanFromBase infers the plan from a gateway base URL.
func PlanFromBase(base string) Plan {
	b := strings.ToLower(NormalizeBase(base))
	if strings.HasPrefix(b, strings.ToLower(GoBase)) || strings.HasPrefix(b, "https://opencode.ai/zen/go") {
		return PlanGo
	}
	return PlanConsole
}

// BaseForPlan returns the canonical gateway root for a plan.
func BaseForPlan(plan Plan) string {
	if plan == PlanGo {
		return GoBase
	}
	return ConsoleBase
}

// Endpoint builds the upstream URL for a request path. For Zen gateways the
// API-family prefix is inserted (OpenAI Chat/Responses, Anthropic Messages,
// or the shared model catalog). Non-Zen bases are passed through unchanged so
// self-hosted OpenAI-compatible providers keep working.
func Endpoint(base, requestPath string) string {
	b := NormalizeBase(base)
	if requestPath == "" {
		requestPath = "/"
	}
	if !IsGateway(b) {
		return b + requestPath
	}
	lower := strings.ToLower(b)
	// A caller may have configured a fully-qualified API-family root.
	for _, suffix := range []string{"/openai/v1", "/anthropic/v1", "/google/v1beta", "/v1"} {
		if strings.HasSuffix(lower, suffix) {
			return b + requestPath
		}
	}
	switch {
	case requestPath == "/models" || strings.HasPrefix(requestPath, "/models?"):
		return b + ModelsPath
	case strings.HasPrefix(requestPath, "/messages"):
		return b + "/anthropic/v1" + requestPath
	case strings.HasPrefix(requestPath, "/responses"):
		return b + "/openai/v1" + requestPath
	default:
		return b + "/openai/v1" + requestPath
	}
}

// IsFreeModel reports whether a model id is one of the free-tier chat models
// that OpenCode restricts to its own client. Other clients must use paid or
// Go models instead of trying to evade the restriction.
func IsFreeModel(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return false
	}
	return strings.HasSuffix(m, "-free") || m == "big-pickle" || strings.HasPrefix(m, "big-pickle-")
}

// PickPaidModel returns the first non-free model id, or "" when the catalog
// only contains free-tier models.
func PickPaidModel(models []string) string {
	for _, m := range models {
		m = strings.TrimSpace(m)
		if m != "" && !IsFreeModel(m) {
			return m
		}
	}
	return ""
}

// ParseRetryAfter parses a Retry-After header (seconds or HTTP date) into a
// non-negative duration. Invalid or past values return 0.
func ParseRetryAfter(value string, now time.Time) time.Duration {
	v := strings.TrimSpace(value)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs <= 0 {
			return 0
		}
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := t.Sub(now); d > 0 {
			return d
		}
	}
	return 0
}

// Usage is the cost/allowance metadata Zen reports beside token usage.
type Usage struct {
	BillingSource string
	Cost          float64
	ListCost      float64
	Allowance     float64
	InputTokens   int64
	OutputTokens  int64
}

// ParseUsage extracts usage.opencode metadata from a complete JSON response
// body. It returns false when no Zen usage object is present.
func ParseUsage(body []byte) (Usage, bool) {
	// Avoid a hard dependency on map[string]any decoding elsewhere; this is
	// deliberately forgiving so unknown fields never break the proxy.
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return Usage{}, false
	}
	usage, _ := root["usage"].(map[string]any)
	if usage == nil {
		return Usage{}, false
	}
	opencode, _ := usage["opencode"].(map[string]any)
	if opencode == nil {
		return Usage{}, false
	}
	out := Usage{}
	out.BillingSource, _ = opencode["billing_source"].(string)
	out.Cost, _ = number(opencode["cost"])
	if out.Cost == 0 {
		out.Cost, _ = number(usage["cost"])
	}
	out.ListCost, _ = number(opencode["list_cost"])
	out.Allowance, _ = number(opencode["allowance"])
	if tokens, ok := opencode["tokens"].(map[string]any); ok {
		in, _ := number(tokens["input"])
		outTok, _ := number(tokens["output"])
		out.InputTokens = int64(in)
		out.OutputTokens = int64(outTok)
	}
	return out, true
}

// ParseUsageFromText extracts Zen usage from a complete response body, which
// may be plain JSON or an SSE stream. For SSE the last usage object wins.
func ParseUsageFromText(text string) (Usage, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return Usage{}, false
	}
	if strings.HasPrefix(trimmed, "{") {
		if u, ok := ParseUsage([]byte(trimmed)); ok {
			return u, true
		}
	}
	var last Usage
	found := false
	for _, line := range strings.Split(trimmed, "\n") {
		t := strings.TrimSpace(line)
		if !strings.HasPrefix(t, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(t, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		if u, ok := ParseUsage([]byte(payload)); ok {
			last = u
			found = true
		}
	}
	return last, found
}

func number(v any) (float64, bool) {
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
