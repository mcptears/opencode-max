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
	"github.com/mcptears/opencode-max/quota"
	"github.com/mcptears/opencode-max/session"
	"github.com/mcptears/opencode-max/types"
	"github.com/mcptears/opencode-max/zen"
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
	// Sessions supplies the stable x-opencode-session id per account.
	Sessions *session.Manager
	// Quota records request counts and Zen allowance/cost metadata.
	Quota *quota.Tracker
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

// resolveBase picks the upstream gateway for an account. An explicit
// account.baseUrl wins; otherwise the account plan, provider plan and finally
// the provider base URL decide. Legacy /zen/v1 prefixes are migrated.
func resolveBase(ac *types.AccountConfig, provider *types.ProviderConfig) string {
	if ac != nil && ac.BaseURL != "" {
		return zen.NormalizeBase(ac.BaseURL)
	}
	plan := zen.Plan("")
	if ac != nil {
		plan = zen.NormalizePlan(ac.Plan)
	}
	if plan == "" && provider != nil {
		plan = zen.NormalizePlan(provider.Plan)
	}
	if plan == zen.PlanGo {
		return zen.GoBase
	}
	if provider != nil && provider.BaseURL != "" {
		base := zen.NormalizeBase(provider.BaseURL)
		if plan == zen.PlanConsole && zen.IsGateway(base) {
			return zen.ConsoleBase
		}
		return base
	}
	return zen.ConsoleBase
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

	protocol := string(provider.Protocol)
	if protocol == "" {
		protocol = "openai"
	}
	stream := parsed.Stream == nil || *parsed.Stream

	maxAttempts := u.MaxRetries + 1
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	var lastErr error
	lastStatus := 502

	for attempt := 0; attempt < maxAttempts; attempt++ {
		ac := u.Pool.AcquireForModel(provider.ID, parsed.Model)
		if ac == nil {
			msg := fmt.Sprintf("no accounts available for provider %q", provider.ID)
			if lastErr != nil {
				msg = fmt.Sprintf("%s: %v", msg, lastErr)
			}
			return api.ForwardResult{Status: 502}, &api.ProviderExhaustedError{Msg: msg}
		}
		u.Metrics.Hit(ac.ID)
		start := time.Now()

		// Native web protocols have their own clients and no transparent retry.
		if protocol != "openai" {
			var body io.ReadCloser
			var err error
			switch protocol {
			case "qwen-web":
				body, err = u.forwardQwen(ctx, ac, provider, parsed, stream)
			case "deepseek-web":
				body, err = u.forwardDeepSeek(ctx, ac, provider, parsed, stream)
			case "zai-web":
				body, err = u.forwardZai(ctx, ac, provider, parsed, stream)
			}
			u.Pool.Release(ac.ID)
			latency := time.Since(start)
			if err != nil {
				u.handleError(ac, err, parsed.Model)
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

		// OpenAI-compatible passthrough.
		result, err := u.forwardOpenAI(ctx, ac, provider, req, parsed.Model)
		latency := time.Since(start)
		if err != nil {
			u.Pool.Release(ac.ID)
			lastErr = err
			lastStatus = 502
			if attempt+1 < maxAttempts && !sleepCtx(ctx, backoffDelay(attempt, u.DefaultCooldown)) {
				return api.ForwardResult{Status: 499}, ctx.Err()
			}
			continue
		}
		if u.Quota != nil && ac.APIKey != "" {
			u.Quota.RecordModel(ac.ID, parsed.Model)
		}

		// Success: pass the body through, sniffing Zen cost/allowance on the
		// way (JSON or final SSE chunk).
		if result.Status >= 200 && result.Status < 300 {
			u.Metrics.Ok()
			u.Metrics.LogRequest(ac.ID, result.Status, latency.Milliseconds(), parsed.Model)
			u.Pool.RecordLatency(ac.ID, latency.Milliseconds())
			u.Pool.Release(ac.ID)
			if u.Quota != nil && result.Body != nil && zen.IsGateway(resolveBase(ac, provider)) {
				result.Body = &usageSniffReader{
					rc:        result.Body,
					accountID: ac.ID,
					model:     parsed.Model,
					quota:     u.Quota,
				}
			}
			return result, nil
		}

		probe := readLimited(result.Body, 64*1024)

		// Dead key: 401, or a 403 that smells like a bad credential (not quota
		// or a free-tier restriction).
		if result.Status == 401 || (result.Status == 403 && looksLikeInvalidKey(probe)) {
			u.Pool.MarkInvalid(ac.ID)
			u.Pool.Release(ac.ID)
			lastErr = fmt.Errorf("upstream %d: %s", result.Status, snippet(probe))
			lastStatus = result.Status
			continue
		}

		if isRetryableStatus(result.Status) {
			cooldown := retryCooldown(result.Headers, u.DefaultCooldown)
			u.Pool.MarkLimitedModel(ac.ID, parsed.Model, cooldown)
			u.Metrics.Limited(ac.ID)
			u.Metrics.Retried()
			u.Pool.Release(ac.ID)
			lastErr = fmt.Errorf("upstream %d: %s", result.Status, snippet(probe))
			lastStatus = result.Status
			if attempt+1 >= maxAttempts {
				break
			}
			// Retry-After (bounded) is honoured; otherwise exponential backoff.
			wait := backoffDelay(attempt, u.DefaultCooldown)
			if ra := zen.ParseRetryAfter(result.Headers["retry-after"], time.Now()); ra > 0 {
				wait = ra
				if wait > 30*time.Second {
					wait = 30 * time.Second
				}
			}
			if !sleepCtx(ctx, wait) {
				return api.ForwardResult{Status: 499}, ctx.Err()
			}
			continue
		}

		// Other 4xx (bad request, unsupported model, free-tier 403…): return
		// the upstream error to the client instead of pretending it worked.
		u.Pool.Release(ac.ID)
		u.Metrics.LogRequest(ac.ID, result.Status, latency.Milliseconds(), parsed.Model)
		return api.ForwardResult{
			Status:  result.Status,
			Headers: result.Headers,
			Body:    io.NopCloser(bytes.NewReader(probe)),
		}, nil
	}

	u.Metrics.LogRequest("none", lastStatus, 0, parsed.Model)
	if lastErr == nil {
		lastErr = fmt.Errorf("upstream request failed")
	}
	return api.ForwardResult{Status: lastStatus}, lastErr
}

func (u *Upstream) handleError(ac *types.AccountConfig, err error, model string) {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "429") || strings.Contains(msg, "rate") || strings.Contains(msg, "quota"):
		u.Pool.MarkLimitedModel(ac.ID, model, u.DefaultCooldown)
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
		c.HTTP = chromeTLSClient(client)
	}
	model := resolveModel(provider, req.Model)
	return c.ChatCompletion(ac.APIKey, ac.Cookies, model, flattenMessages(req.Messages), stream)
}

// chromeTLSClient returns a copy of client whose TLS handshakes impersonate
// Chrome. Qwen's Baxia WAF fingerprints the TLS ClientHello; Go's stock
// fingerprint is a strong bot signal even when headers and cookies are
// browser-perfect.
func chromeTLSClient(client *http.Client) *http.Client {
	out := &http.Client{Timeout: client.Timeout}
	if tr, ok := client.Transport.(*http.Transport); ok {
		out.Transport = proxy.ChromeTLSClone(tr)
	} else {
		out.Transport = proxy.ChromeTLSClone(nil)
	}
	if client.Jar != nil {
		out.Jar = client.Jar
	}
	if client.CheckRedirect != nil {
		out.CheckRedirect = client.CheckRedirect
	}
	return out
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

func (u *Upstream) forwardOpenAI(ctx context.Context, ac *types.AccountConfig, provider *types.ProviderConfig, req api.ForwardRequest, model string) (api.ForwardResult, error) {
	base := resolveBase(ac, provider)
	url := zen.Endpoint(base, req.Path)
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
	if zen.IsGateway(base) {
		// Identify as opencode-max. Never impersonate the official OpenCode
		// client: free-tier models are reserved for it and other clients must
		// use paid/Go models instead.
		httpReq.Header.Set("User-Agent", zen.UserAgent)
		if u.Sessions != nil {
			httpReq.Header.Set("x-opencode-session", u.Sessions.IDFor(ac.ID))
		}
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
// across every proxy). When there is no proxy to use (direct mode, empty
// pool, or no rotator), it returns u.HTTP — the standard client, which
// honors ProxyFromEnvironment — instead of a raw direct dialer.
func (u *Upstream) clientFor(ac *types.AccountConfig) *http.Client {
	var proxyURL string
	switch ac.ProxyModeEffective() {
	case "single":
		proxyURL = strings.TrimSpace(ac.ProxyURL)
	case "pool":
		if u.Rotator != nil {
			proxyURL = u.Rotator.Rotate()
		}
	}
	if proxyURL == "" || u.Rotator == nil {
		return u.HTTP
	}
	return u.Rotator.HTTPClient(proxyURL)
}

// matchProvider mirrors providers.MatchProvider.
func matchProvider(provs []types.ProviderConfig, model string) *types.ProviderConfig {
	return providers.MatchProvider(provs, model)
}

// ---------------------------------------------------------------------------
// Retry / error helpers
// ---------------------------------------------------------------------------

func isRetryableStatus(status int) bool {
	switch status {
	case 408, 425, 429, 500, 502, 503, 504:
		return true
	}
	return false
}

func looksLikeInvalidKey(body []byte) bool {
	s := strings.ToLower(string(body))
	invalid := strings.Contains(s, "invalid") || strings.Contains(s, "unauthorized") ||
		strings.Contains(s, "api key") || strings.Contains(s, "api_key") || strings.Contains(s, "bad credentials")
	quota := strings.Contains(s, "quota") || strings.Contains(s, "rate limit") || strings.Contains(s, "too many")
	return invalid && !quota
}

func retryCooldown(headers map[string]string, fallback time.Duration) time.Duration {
	if ra := zen.ParseRetryAfter(headers["retry-after"], time.Now()); ra > 0 {
		return ra
	}
	return fallback
}

func backoffDelay(attempt int, fallback time.Duration) time.Duration {
	base := 500 * time.Millisecond
	if fallback > 0 && fallback < base {
		base = fallback
	}
	max := 30 * time.Second
	d := base
	for i := 0; i < attempt; i++ {
		d *= 2
		if d >= max {
			return max
		}
	}
	if d > max {
		return max
	}
	return d
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func readLimited(r io.ReadCloser, max int64) []byte {
	if r == nil {
		return nil
	}
	defer r.Close()
	b, _ := io.ReadAll(io.LimitReader(r, max))
	return b
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// usageSniffReader passes response bytes through unchanged and records Zen
// cost/allowance metadata once the body ends (JSON or final SSE chunk).
type usageSniffReader struct {
	rc        io.ReadCloser
	accountID string
	model     string
	quota     *quota.Tracker
	buf       bytes.Buffer
	done      bool
}

const maxUsageSniff = 2 * 1024 * 1024

func (r *usageSniffReader) Read(p []byte) (int, error) {
	n, err := r.rc.Read(p)
	if n > 0 && !r.done && r.buf.Len() < maxUsageSniff {
		_, _ = r.buf.Write(p[:n])
	}
	if err == io.EOF {
		r.flush()
	}
	return n, err
}

func (r *usageSniffReader) Close() error {
	r.flush()
	return r.rc.Close()
}

func (r *usageSniffReader) flush() {
	if r.done {
		return
	}
	r.done = true
	if u, ok := zen.ParseUsageFromText(r.buf.String()); ok {
		r.quota.RecordZenUsage(r.accountID, r.model, u)
	}
}
