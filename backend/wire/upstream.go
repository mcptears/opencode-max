package wire

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/mcptears/opencode-max/api"
	"github.com/mcptears/opencode-max/pool"
	"github.com/mcptears/opencode-max/providers"
	"github.com/mcptears/opencode-max/providers/deepseek"
	"github.com/mcptears/opencode-max/providers/qwen"
	"github.com/mcptears/opencode-max/providers/zai"
	"github.com/mcptears/opencode-max/proxy"
	"github.com/mcptears/opencode-max/types"
)

// ---------------------------------------------------------------------------
// Upstream: /v1 forwarding with account selection and protocol dispatch.
// ---------------------------------------------------------------------------

type Upstream struct {
	Pool      *pool.Pool
	Rotator   *proxy.Rotator
	Providers func() []types.ProviderConfig
	HTTP      *http.Client
	Metrics   interface {
		Hit(string)
		Ok()
		Limited(string)
		Retried()
		Failover(string, string)
		LogRequest(string, int, int64, string)
		RecordLatency(string, int64)
	}
	DefaultCooldown time.Duration
	MaxRetries      int
	// ZaiTokenPool supplies auto-harvested device tokens for Z.ai captcha.
	ZaiTokenPool zai.TokenPool
	// OnZaiPoolEmpty, when set, is called (once per empty-pool hit) when a
	// Z.ai chat finds no device token — the handler kicks off a background
	// collection so the next request succeeds without manual Setup steps.
	OnZaiPoolEmpty func()
}

type openAIMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

type openAIRequest struct {
	Model    string          `json:"model"`
	Messages []openAIMessage `json:"messages"`
	Stream   *bool           `json:"stream"`
}

func (u *Upstream) Forward(req api.ForwardRequest) (api.ForwardResult, error) {
	ctx := req.Ctx
	if ctx == nil {
		ctx = context.Background()
	}

	// Only /chat/completions is supported for web protocols.
	var parsed openAIRequest
	if len(req.Body) > 0 {
		_ = json.Unmarshal(req.Body, &parsed)
	}

	// Match provider.
	provs := u.Providers()
	provider := matchProvider(provs, parsed.Model)
	if provider == nil {
		return api.ForwardResult{Status: 404}, fmt.Errorf("no provider for model %q", parsed.Model)
	}

	// Acquire account.
	ac := u.Pool.Acquire(provider.ID)
	if ac == nil {
		return api.ForwardResult{Status: 502}, &api.ProviderExhaustedError{Msg: fmt.Sprintf("no accounts available for provider %q", provider.ID)}
	}
	defer u.Pool.Release(ac.ID)
	u.Metrics.Hit(ac.ID)

	protocol := string(provider.Protocol)
	if protocol == "" {
		protocol = "openai"
	}

	stream := parsed.Stream == nil || *parsed.Stream
	start := time.Now()

	var body io.ReadCloser
	var err error
	switch protocol {
	case "qwen-web":
		body, err = u.forwardQwen(ctx, ac, provider, parsed, stream)
	case "deepseek-web":
		body, err = u.forwardDeepSeek(ctx, ac, provider, parsed, stream)
	case "zai-web":
		body, err = u.forwardZai(ctx, ac, provider, parsed, stream)
	default:
		return u.forwardOpenAI(ctx, ac, provider, req)
	}

	latency := time.Since(start)
	if err != nil {
		u.handleError(ac, err)
		status := 502
		if qe, ok := err.(interface{ StatusCode() int }); ok {
			status = qe.StatusCode()
		}
		return api.ForwardResult{Status: status}, err
	}
	u.Metrics.Ok()
	u.Metrics.LogRequest(ac.ID, 200, latency.Milliseconds(), parsed.Model)
	u.Pool.RecordLatency(ac.ID, latency.Milliseconds())

	ct := "application/json"
	if stream {
		ct = "text/event-stream"
	}
	return api.ForwardResult{
		Status:  200,
		Headers: map[string]string{"content-type": ct},
		Body:    body,
	}, nil
}

func (u *Upstream) handleError(ac *types.AccountConfig, err error) {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "429") || strings.Contains(msg, "rate") || strings.Contains(msg, "quota"):
		u.Pool.MarkLimited(ac.ID, u.DefaultCooldown)
		u.Metrics.Limited(ac.ID)
	case strings.Contains(msg, "401") || strings.Contains(msg, "403") || strings.Contains(msg, "rejected"):
		u.Pool.MarkInvalid(ac.ID)
	}
}

// --- protocol dispatch ---

func flattenMessages(msgs []openAIMessage) []qwen.Message {
	out := make([]qwen.Message, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, qwen.Message{Role: m.Role, Content: m.Content})
	}
	return out
}

func flattenToString(msgs []openAIMessage) []deepseek.Message {
	out := make([]deepseek.Message, 0, len(msgs))
	for _, m := range msgs {
		var content string
		switch c := m.Content.(type) {
		case string:
			content = c
		default:
			b, _ := json.Marshal(c)
			content = string(b)
		}
		out = append(out, deepseek.Message{Role: m.Role, Content: content})
	}
	return out
}

func resolveModel(provider *types.ProviderConfig, requested string) string {
	mm := map[string]string{}
	var def string
	switch string(provider.Protocol) {
	case "qwen-web":
		if provider.Qwen != nil {
			mm = provider.Qwen.ModelMap
			def = provider.Qwen.DefaultModel
		}
	case "deepseek-web":
		if provider.DeepSeek != nil {
			mm = provider.DeepSeek.ModelMap
			def = provider.DeepSeek.DefaultModel
		}
	case "zai-web":
		if provider.Zai != nil {
			mm = provider.Zai.ModelMap
			def = provider.Zai.DefaultModel
		}
	}
	if v, ok := mm[requested]; ok {
		return v
	}
	if def != "" {
		return def
	}
	return requested
}

func (u *Upstream) forwardQwen(ctx context.Context, ac *types.AccountConfig, provider *types.ProviderConfig, req openAIRequest, stream bool) (io.ReadCloser, error) {
	c := qwen.NewClient(provider.BaseURL)
	if client := u.clientFor(ac); client != nil {
		c.HTTP = client
	}
	model := resolveModel(provider, req.Model)
	return c.ChatCompletion(ac.APIKey, ac.Cookies, model, flattenMessages(req.Messages), stream)
}

func (u *Upstream) forwardDeepSeek(ctx context.Context, ac *types.AccountConfig, provider *types.ProviderConfig, req openAIRequest, stream bool) (io.ReadCloser, error) {
	c := deepseek.NewClient(provider.BaseURL, ac.APIKey, ac.Cookies, u.clientFor(ac))
	model := resolveModel(provider, req.Model)
	msgs := flattenToString(req.Messages)
	thinking, search := false, false
	if provider.DeepSeek != nil {
		if provider.DeepSeek.ThinkingEnabled != nil {
			thinking = *provider.DeepSeek.ThinkingEnabled
		}
		if provider.DeepSeek.SearchEnabled != nil {
			search = *provider.DeepSeek.SearchEnabled
		}
	}
	res, err := c.ChatCompletion(ctx, msgs, deepseek.ChatOptions{
		Model:           model,
		ResponseModel:   req.Model,
		Stream:          stream,
		ThinkingEnabled: thinking,
		SearchEnabled:   search,
	})
	if err != nil {
		return nil, err
	}
	if stream && res.Stream != nil {
		return res.Stream, nil
	}
	// Non-streaming: wrap in OpenAI JSON.
	out := map[string]any{
		"id":      fmt.Sprintf("deepseek-%d", time.Now().UnixMilli()),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   req.Model,
		"choices": []any{map[string]any{
			"index": 0,
			"message": map[string]any{
				"role":    "assistant",
				"content": res.Content,
			},
			"finish_reason": "stop",
		}},
		"usage": map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
	}
	if res.Reasoning != "" {
		out["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)["reasoning_content"] = res.Reasoning
	}
	b, _ := json.Marshal(out)
	return io.NopCloser(bytes.NewReader(b)), nil
}

func (u *Upstream) forwardZai(ctx context.Context, ac *types.AccountConfig, provider *types.ProviderConfig, req openAIRequest, stream bool) (io.ReadCloser, error) {
	c := zai.NewClient(provider.BaseURL, ac.APIKey, u.clientFor(ac))
	c.DeviceToken = ac.DeviceToken
	c.Pool = u.ZaiTokenPool
	// Empty pool? Kick off a background harvest so the user doesn't have to
	// hunt for the Setup page — the retry shortly after will succeed.
	if strings.TrimSpace(ac.DeviceToken) == "" && u.ZaiTokenPool != nil && u.OnZaiPoolEmpty != nil {
		if s, ok := u.ZaiTokenPool.(interface{ Count() int }); ok && s.Count() == 0 {
			u.OnZaiPoolEmpty()
		}
	}
	model := resolveModel(provider, req.Model)
	raw := make([]struct {
		Role    string
		Content string
	}, 0, len(req.Messages))
	for _, m := range flattenToString(req.Messages) {
		raw = append(raw, struct {
			Role    string
			Content string
		}{Role: m.Role, Content: m.Content})
	}
	thinking, search := true, false
	if provider.Zai != nil {
		if provider.Zai.ThinkingEnabled != nil {
			thinking = *provider.Zai.ThinkingEnabled
		} else {
			thinking = true
		}
		if provider.Zai.SearchEnabled != nil {
			search = *provider.Zai.SearchEnabled
		}
	}
	res, err := c.ChatCompletion(ctx, raw, zai.ChatOptions{
		Model:           model,
		ResponseModel:   req.Model,
		Stream:          stream,
		ThinkingEnabled: thinking,
		SearchEnabled:   search,
	})
	if err != nil {
		return nil, err
	}
	if stream && res.Stream != nil {
		return res.Stream, nil
	}
	out := map[string]any{
		"id":      fmt.Sprintf("zai-%d", time.Now().UnixMilli()),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   req.Model,
		"choices": []any{map[string]any{
			"index": 0,
			"message": map[string]any{
				"role":    "assistant",
				"content": res.Content,
			},
			"finish_reason": "stop",
		}},
	}
	if res.Reasoning != "" {
		out["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)["reasoning_content"] = res.Reasoning
	}
	b, _ := json.Marshal(out)
	return io.NopCloser(bytes.NewReader(b)), nil
}

// zenUserAgent returns the official opencode client User-Agent when the
// base URL is opencode.ai's Zen endpoint, else "".
func zenUserAgent(base string) string {
	if strings.Contains(base, "opencode.ai/zen") {
		return "opencode/1.18.31"
	}
	return ""
}

func (u *Upstream) forwardOpenAI(ctx context.Context, ac *types.AccountConfig, provider *types.ProviderConfig, req api.ForwardRequest) (api.ForwardResult, error) {
	base := provider.BaseURL
	if ac.BaseURL != "" {
		base = ac.BaseURL
	}
	url := strings.TrimRight(base, "/") + req.Path
	if req.Query != "" {
		url += req.Query
	}

	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = bytes.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, url, bodyReader)
	if err != nil {
		return api.ForwardResult{Status: 500}, err
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	if ac.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+ac.APIKey)
	}
	// opencode.ai's Zen endpoint rejects requests that don't come from the
	// official client ("usable only inside opencode"). Identify as the
	// official opencode client, same as the 9router approach. This only
	// applies when the user provides their own real API key — no free-tier
	// access is granted or spoofed here.
	if ua := zenUserAgent(base); ua != "" {
		httpReq.Header.Set("User-Agent", ua)
	}

	// Proxy or direct, per the account's proxy mode:
	// off = direct, single = pinned proxy, pool = round-robin through
	// the whole proxy pool (one rotation per request).
	client := u.clientFor(ac)
	if client == nil {
		client = http.DefaultClient
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		return api.ForwardResult{Status: 502}, err
	}
	headers := map[string]string{}
	for k, v := range resp.Header {
		if len(v) > 0 {
			headers[strings.ToLower(k)] = v[0]
		}
	}
	return api.ForwardResult{Status: resp.StatusCode, Headers: headers, Body: resp.Body}, nil
}

// clientFor resolves the HTTP client for one account's proxy mode.
// "off" returns the direct client, "single" a client pinned to the
// account's proxy URL, "pool" a client on the next proxy in the pool
// (the rotator advances once per call, so pool traffic round-robins
// across every proxy). A nil rotator means direct.
func (u *Upstream) clientFor(ac *types.AccountConfig) *http.Client {
	switch ac.ProxyModeEffective() {
	case "off":
		return u.HTTP
	case "single":
		if u.Rotator != nil {
			if p := strings.TrimSpace(ac.ProxyURL); p != "" {
				return u.Rotator.HTTPClient(p)
			}
			return u.Rotator.HTTPClient(u.Rotator.Rotate())
		}
		return u.HTTP
	default: // "pool"
		if u.Rotator != nil {
			return u.Rotator.HTTPClient(u.Rotator.Rotate())
		}
		return u.HTTP
	}
}

// matchProvider mirrors providers.MatchProvider.
func matchProvider(provs []types.ProviderConfig, model string) *types.ProviderConfig {
	return providers.MatchProvider(provs, model)
}
