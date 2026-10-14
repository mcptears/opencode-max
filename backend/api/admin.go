package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mcptears/opencode-max/middleware"
)

// registerAdmin registers every /api/* route on the chi sub-router.
func (s *Server) registerAdmin(r chi.Router) {
	// ---- status / metrics / logs ----
	r.Get("/status", s.handleStatus)
	r.Get("/metrics", s.handleMetrics)
	r.Get("/metrics/summary", s.handleMetricsSummary)
	r.Get("/logs", s.handleLogs)
	r.Delete("/logs", s.handleClearLogs)
	r.Post("/logs/clear", s.handleClearLogs)
	r.Get("/metrics/history", s.handleMetricsHistory)
	r.Get("/metrics/models", s.handleMetricsModels)
	r.Get("/usage", s.handleUsage)
	r.Get("/metrics/providers", s.handleMetricsProviders)
	r.Get("/requests", s.handleRequests)

	// ---- accounts ----
	r.Get("/accounts", s.handleListAccounts)
	r.Post("/accounts/validate-qwen", s.handleValidateQwen)
	r.Post("/accounts/qwen-login", s.handleQwenLogin)
	r.Post("/accounts/validate-deepseek", s.handleValidateDeepSeek)
	r.Post("/accounts/deepseek-login", s.handleDeepSeekLogin)
	r.Post("/accounts/deepseek-resend-code", s.handleDeepSeekResendCode)
	r.Post("/accounts/validate-zai", s.handleValidateZai)
	r.Post("/accounts/validate", s.handleValidateKey)
	r.Post("/accounts", s.handleCreateAccount)
	r.Put("/accounts/{id}", s.handleUpdateAccount)
	r.Patch("/accounts/{id}", s.handlePatchAccount)
	r.Delete("/accounts/{id}", s.handleDeleteAccount)
	r.Post("/accounts/{id}/reset", s.handleResetAccount)

	// ---- providers ----
	r.Get("/providers", s.handleListProviders)
	r.Post("/providers", s.handleCreateProvider)
	r.Put("/providers/{id}", s.handleUpdateProvider)
	r.Delete("/providers/{id}", s.handleDeleteProvider)
	r.Post("/providers/preset/qwen", s.handlePresetQwen)
	r.Post("/providers/preset/deepseek", s.handlePresetDeepSeek)
	r.Post("/providers/preset/opencode-zen", s.handlePresetOpenCodeZen)
	r.Post("/providers/preset/zai", s.handlePresetZai)
	r.Post("/providers/{id}/test", s.handleTestProvider)

	// ---- proxies ----
	r.Get("/proxies", s.handleListProxies)
	r.Post("/proxies", s.handleSetProxies)
	r.Delete("/proxies", s.handleDeleteProxy)
	r.Post("/rotate", s.handleRotate)
	r.Post("/proxies/test", s.handleTestProxies)
	r.Post("/proxies/check", s.handleCheckProxies)

	// ---- proxy scraper ----
	r.Get("/scraper/providers", s.handleListScraperProviders)
	r.Get("/scraper/status", s.handleScraperStatus)
	r.Post("/scraper/run", s.handleScraperRun)

	// ---- z.ai device tokens (auto-harvested pool for captcha) ----
	r.Get("/zai/tokens", s.handleZaiTokensStatus)
	r.Post("/zai/tokens/collect", s.handleZaiTokensCollect)
	r.Delete("/zai/tokens", s.handleZaiTokensClear)
	r.Post("/scraper/providers", s.handleCreateScraperProvider)
	r.Put("/scraper/providers/{id}", s.handleUpdateScraperProvider)
	r.Delete("/scraper/providers/{id}", s.handleDeleteScraperProvider)

	// ---- settings ----
	r.Get("/settings", s.handleGetSettings)
	r.Post("/settings", s.handlePostSettings)
	r.Put("/settings", s.handlePostSettings)

	// ---- backup / restore (GET requires auth even though it is a read) ----
	r.With(middleware.AdminAuth(func() string { return s.deps.Settings.Get().AdminToken })).
		Get("/backup", s.handleBackup)
	r.Post("/backup/restore", s.handleRestoreBackup)

	// ---- playground (admin-authed via the /api mutation guard) ----
	r.Get("/playground/models", s.handlePlaygroundModels)
	r.Post("/playground/chat", s.handlePlaygroundChat)
}

// providerOf rebuilds the account-id -> provider map per call so dashboard
// edits apply live.
func (s *Server) providerOf() func(string) string {
	m := map[string]string{}
	for _, a := range s.deps.Pool.Status() {
		m[a.ID] = a.Provider
	}
	return func(id string) string { return m[id] }
}

func queryInt(r *http.Request, key string, def, min, max int) int {
	n, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// ---------------------------------------------------------------------------
// status / metrics / logs
// ---------------------------------------------------------------------------

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	st := s.deps.Settings.Get()
	writeJSON(w, 200, map[string]any{
		"ok":           true,
		"version":      "1.0.0",
		"port":         st.Port,
		"upstream":     st.UpstreamBase,
		"accounts":     s.deps.Pool.Status(),
		"ip":           s.deps.Rotator.Status(),
		"metrics":      s.deps.Metrics.Summary(),
		"quota5hLimit": st.Quota5hLimit,
	})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"metrics": s.deps.Metrics.Summary(),
		"events":  s.deps.Metrics.RecentEvents(50),
	})
}

// handleMetricsSummary returns the dashboard-friendly overview shape:
// {totalRequests, successRate, avgLatencyMs, activeAccounts, totalAccounts}.
func (s *Server) handleMetricsSummary(w http.ResponseWriter, r *http.Request) {
	sum := s.deps.Metrics.Summary()
	// Summary() returns metrics.Summary; extract via JSON round-trip to avoid
	// coupling to its concrete type.
	var sm struct {
		Requests  int64 `json:"requests"`
		Successes int64 `json:"successes"`
	}
	if b, err := json.Marshal(sum); err == nil {
		_ = json.Unmarshal(b, &sm)
	}
	var successRate float64
	if sm.Requests > 0 {
		successRate = float64(sm.Successes) / float64(sm.Requests)
	}
	// Avg latency over recent requests.
	var totalLat int64
	var latN int64
	for _, rq := range decodeLogRows(s.deps.Metrics.RecentLogRequests(100)) {
		totalLat += int64(rq.LatencyMs)
		latN++
	}
	var avgLatency float64
	if latN > 0 {
		avgLatency = float64(totalLat) / float64(latN)
	}
	// Account counts from pool status.
	var active, total int
	for _, a := range s.deps.Pool.Status() {
		total++
		if a.State == "active" {
			active++
		}
	}
	writeJSON(w, 200, map[string]any{
		"totalRequests":  sm.Requests,
		"successRate":    successRate,
		"avgLatencyMs":   avgLatency,
		"activeAccounts": active,
		"totalAccounts":  total,
	})
}

// handlePlaygroundModels returns the model names from all enabled providers.
// Web-protocol providers expand via their modelMap keys; otherwise the raw
// model patterns are returned (bare "*" catch-alls are skipped).
func (s *Server) handlePlaygroundModels(w http.ResponseWriter, r *http.Request) {
	seen := map[string]bool{}
	var models []string
	add := func(m string) {
		m = strings.TrimSpace(m)
		if m == "" || m == "*" || seen[m] {
			return
		}
		seen[m] = true
		models = append(models, m)
	}
	for _, p := range s.deps.Providers.Load() {
		if !p.Enabled {
			continue
		}
		expanded := false
		if p.Qwen != nil {
			for k := range p.Qwen.ModelMap {
				add(k)
			}
			if len(p.Qwen.ModelMap) > 0 {
				expanded = true
			}
		}
		if p.DeepSeek != nil {
			for k := range p.DeepSeek.ModelMap {
				add(k)
			}
			if len(p.DeepSeek.ModelMap) > 0 {
				expanded = true
			}
		}
		if p.Zai != nil {
			for k := range p.Zai.ModelMap {
				add(k)
			}
			if len(p.Zai.ModelMap) > 0 {
				expanded = true
			}
		}
		if !expanded {
			for _, m := range p.Models {
				add(m)
			}
		}
	}
	if models == nil {
		models = []string{}
	}
	writeJSON(w, 200, models)
}

// requestLogRow mirrors metrics.RequestLogRow without importing the package.
type requestLogRow struct {
	T         int64  `json:"t"`
	AccountID string `json:"accountId"`
	Model     string `json:"model"`
	Status    int    `json:"status"`
	LatencyMs int    `json:"latencyMs"`
}

func decodeLogRows(in []any) []requestLogRow {
	var out []requestLogRow
	if b, err := json.Marshal(in); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 100, 1, 200)
	// Merged chronological feed: model requests + system events, newest first.
	// Shape matches the dashboard: {time, kind, message, status?}.
	var feed []logEntry
	for _, rq := range decodeLogRows(s.deps.Metrics.RecentLogRequests(limit)) {
		st := rq.Status
		msg := rq.Model
		if rq.AccountID != "" {
			msg += " via " + rq.AccountID
		}
		feed = append(feed, logEntry{
			Time:    time.UnixMilli(rq.T).Format("15:04:05"),
			Kind:    "request",
			Message: msg,
			Status:  &st,
		})
	}
	for _, ev := range s.deps.Metrics.RecentEvents(50) {
		var tStr, kind, detail string
		if b, err := json.Marshal(ev); err == nil {
			var m map[string]any
			if json.Unmarshal(b, &m) == nil {
				if t, ok := m["t"].(float64); ok {
					tStr = time.UnixMilli(int64(t)).Format("15:04:05")
				}
				if k, ok := m["kind"].(string); ok {
					kind = k
				}
				if d, ok := m["detail"].(string); ok {
					detail = d
				}
			}
		}
		if tStr == "" {
			continue
		}
		feed = append(feed, logEntry{Time: tStr, Kind: kind, Message: detail})
	}
	if feed == nil {
		feed = []logEntry{}
	}
	writeJSON(w, 200, feed)
}

// logEntry is the dashboard-friendly log row.
type logEntry struct {
	Time    string `json:"time"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Status  *int   `json:"status,omitempty"`
}

func (s *Server) handleClearLogs(w http.ResponseWriter, r *http.Request) {
	s.deps.Metrics.ClearLogs()
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleMetricsHistory(w http.ResponseWriter, r *http.Request) {
	hours := queryInt(r, "hours", 24, 1, 168)
	writeJSON(w, 200, map[string]any{"hours": hours, "buckets": s.deps.Metrics.History(hours)})
}

func (s *Server) handleMetricsModels(w http.ResponseWriter, r *http.Request) {
	hours := queryInt(r, "hours", 24, 1, 168)
	writeJSON(w, 200, map[string]any{"hours": hours, "models": s.deps.Metrics.ModelStats(hours, s.providerOf())})
}

func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	hours := queryInt(r, "hours", 24, 1, 168)
	stats := map[string]any{}
	if m, ok := s.deps.Metrics.UsageStats(hours).(map[string]any); ok {
		stats = m
	}
	out := map[string]any{"hours": hours}
	for k, v := range stats {
		out[k] = v
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleMetricsProviders(w http.ResponseWriter, r *http.Request) {
	hours := queryInt(r, "hours", 24, 1, 168)
	writeJSON(w, 200, map[string]any{"hours": hours, "providers": s.deps.Metrics.ProviderHealth(hours, s.providerOf())})
}

func (s *Server) handleRequests(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 50, 1, 200)
	writeJSON(w, 200, map[string]any{"requests": s.deps.Metrics.RecentRequests(limit, s.providerOf())})
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

func (s *Server) handleListAccounts(w http.ResponseWriter, r *http.Request) {
	// Never leak keys: status view only. Bare array for the dashboard.
	writeJSON(w, 200, s.deps.Pool.Status())
}

func qwenBaseURL(s *Server, body map[string]any) string {
	if v, _ := body["baseUrl"].(string); strings.TrimSpace(v) != "" {
		return strings.TrimRight(strings.TrimSpace(v), "/")
	}
	for _, p := range s.deps.Providers.Load() {
		if p.Protocol == "qwen-web" {
			return p.BaseURL
		}
	}
	return "https://chat.qwen.ai"
}

func (s *Server) handleValidateQwen(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	credential, _ := body["credential"].(string)
	credential = strings.TrimSpace(credential)
	cookies, _ := body["cookies"].(string)
	if credential == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "credential is required"})
		return
	}
	res := s.deps.WebAuth.ValidateQwen(r.Context(), qwenBaseURL(s, body), credential, strings.TrimSpace(cookies))
	writeJSON(w, 200, res)
}

func passwordHashOf(body map[string]any) (string, bool) {
	if h, _ := body["passwordHash"].(string); strings.TrimSpace(h) != "" {
		return strings.TrimSpace(h), true
	}
	if p, _ := body["password"].(string); p != "" {
		sum := sha256.Sum256([]byte(p))
		return hex.EncodeToString(sum[:]), true
	}
	return "", false
}

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *Server) handleQwenLogin(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	email, _ := body["email"].(string)
	email = strings.TrimSpace(email)
	hash, _ := passwordHashOf(body)
	if email == "" || !strings.Contains(email, "@") {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "a valid email is required"})
		return
	}
	if !sha256Hex.MatchString(strings.ToLower(hash)) {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "password is required"})
		return
	}
	preset := QwenPreset()
	providers := s.deps.Providers.Load()
	qwenProvider := findProvider(providers, "qwen-web")
	if qwenProvider == nil {
		providers = append(providers, preset)
		s.deps.Providers.Save(providers)
		qwenProvider = &preset
		s.deps.Metrics.Record("settings", "native qwen provider preset added (via Qwen sign-in)")
	}
	// Prefer the automated browser login when the raw password is available
	// (harvests the session token via headless Chromium — no DevTools needed).
	// Falls back to the hash-based API sign-in otherwise.
	var login SignInResult
	if rawPassword, _ := body["password"].(string); strings.TrimSpace(rawPassword) != "" {
		login = s.deps.WebAuth.QwenBrowserSignIn(r.Context(), email, rawPassword)
	} else {
		login = s.deps.WebAuth.QwenSignIn(r.Context(), qwenProvider.BaseURL, email, hash)
	}
	if !login.OK {
		writeJSON(w, 200, login)
		return
	}
	accounts := s.deps.Accounts.Read()
	id := nextAccountID(accounts, "qwen")
	name, _ := body["name"].(string)
	name = strings.TrimSpace(name)
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	priority := len(accounts) + 1
	if p, ok := toFloat(body["priority"]); ok {
		priority = int(p)
	}
	account := AccountConfig{ID: id, Name: name, Provider: qwenProvider.ID, APIKey: login.Credential, Priority: priority}
	if strings.TrimSpace(login.Cookies) != "" {
		account.Cookies = strPtr(strings.TrimSpace(login.Cookies))
	}
	accounts = append(accounts, account)
	s.deps.Accounts.Write(accounts)
	s.deps.Pool.Replace(accounts)
	s.deps.Metrics.Record("account_added", fmt.Sprintf("qwen account '%s' connected via sign-in", id))
	writeJSON(w, 201, map[string]any{"ok": true, "id": id})
}

func deepseekBaseURL(s *Server, body map[string]any) string {
	if v, _ := body["baseUrl"].(string); strings.TrimSpace(v) != "" {
		return strings.TrimRight(strings.TrimSpace(v), "/")
	}
	for _, p := range s.deps.Providers.Load() {
		if p.Protocol == "deepseek-web" {
			return p.BaseURL
		}
	}
	return "https://chat.deepseek.com"
}

func (s *Server) handleValidateDeepSeek(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	credential, _ := body["credential"].(string)
	credential = strings.TrimSpace(credential)
	cookies, _ := body["cookies"].(string)
	if credential == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "credential is required"})
		return
	}
	res := s.deps.WebAuth.ValidateDeepSeek(r.Context(), deepseekBaseURL(s, body), credential, strings.TrimSpace(cookies))
	writeJSON(w, 200, res)
}

func (s *Server) handleDeepSeekLogin(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	email, _ := body["email"].(string)
	email = strings.TrimSpace(email)
	hash, _ := passwordHashOf(body)
	if email == "" || !strings.Contains(email, "@") {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "a valid email is required"})
		return
	}
	if !sha256Hex.MatchString(strings.ToLower(hash)) {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "password is required"})
		return
	}
	code, _ := body["verificationCode"].(string)
	preset := DeepSeekPreset()
	providers := s.deps.Providers.Load()
	dsProvider := findProvider(providers, "deepseek-web")
	if dsProvider == nil {
		providers = append(providers, preset)
		s.deps.Providers.Save(providers)
		dsProvider = &preset
		s.deps.Metrics.Record("settings", "native deepseek provider preset added (via DeepSeek sign-in)")
	}
	login := s.deps.WebAuth.DeepSeekSignIn(r.Context(), dsProvider.BaseURL, email, hash, strings.TrimSpace(code))
	if !login.OK {
		writeJSON(w, 200, login)
		return
	}
	accounts := s.deps.Accounts.Read()
	id := nextAccountID(accounts, "deepseek")
	name, _ := body["name"].(string)
	name = strings.TrimSpace(name)
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	priority := len(accounts) + 1
	if p, ok := toFloat(body["priority"]); ok {
		priority = int(p)
	}
	account := AccountConfig{ID: id, Name: name, Provider: dsProvider.ID, APIKey: login.Credential, Priority: priority}
	if strings.TrimSpace(login.Cookies) != "" {
		account.Cookies = strPtr(strings.TrimSpace(login.Cookies))
	}
	accounts = append(accounts, account)
	s.deps.Accounts.Write(accounts)
	s.deps.Pool.Replace(accounts)
	s.deps.Metrics.Record("account_added", fmt.Sprintf("deepseek account '%s' connected via sign-in", id))
	writeJSON(w, 201, map[string]any{"ok": true, "id": id})
}

func (s *Server) handleDeepSeekResendCode(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	email, _ := body["email"].(string)
	email = strings.TrimSpace(email)
	if email == "" || !strings.Contains(email, "@") {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "a valid email is required"})
		return
	}
	baseURL := DeepSeekPreset().BaseURL
	for _, p := range s.deps.Providers.Load() {
		if p.Protocol == "deepseek-web" {
			baseURL = p.BaseURL
			break
		}
	}
	res := s.deps.WebAuth.ResendDeepSeekCode(r.Context(), baseURL, email)
	writeJSON(w, 200, res)
}

func (s *Server) handleValidateZai(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	credential, _ := body["credential"].(string)
	credential = strings.TrimSpace(credential)
	if credential == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "token is required"})
		return
	}
	baseURL := ZaiPreset().BaseURL
	if v, _ := body["baseUrl"].(string); strings.TrimSpace(v) != "" {
		baseURL = strings.TrimRight(strings.TrimSpace(v), "/")
	} else {
		for _, p := range s.deps.Providers.Load() {
			if p.Protocol == "zai-web" {
				baseURL = p.BaseURL
				break
			}
		}
	}
	res := s.deps.WebAuth.ValidateZai(r.Context(), baseURL, credential)
	writeJSON(w, 200, res)
}

var invalidKeyHints = regexp.MustCompile(`(?i)invalid|unauthorized|api.?key|bad.?credentials|incorrect`)
var quotaHints = regexp.MustCompile(`(?i)quota|rate`)

// handleValidateKey checks an API key against upstream with a minimal 1-token
// chat ping: 401 with an auth-flavoured body means a bad key; anything else
// (200, 429, model errors) means the key itself is accepted.
func (s *Server) handleValidateKey(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	apiKey, _ := body["apiKey"].(string)
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "API key is required"})
		return
	}
	base := s.deps.Settings.Get().UpstreamBase
	if v, _ := body["baseUrl"].(string); strings.TrimSpace(v) != "" {
		base = strings.TrimRight(strings.TrimSpace(v), "/")
	}
	authHeader := "Bearer " + apiKey
	withTimeout := func(ctx context.Context, url, method string, payload any) (*http.Response, error) {
		tctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		var reqBody []byte
		if payload != nil {
			reqBody, _ = json.Marshal(payload)
		}
		req, err := http.NewRequestWithContext(tctx, method, url, bytesReader(reqBody))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", authHeader)
		req.Header.Set("Content-Type", "application/json")
		return http.DefaultClient.Do(req)
	}
	fail := func(msg string) {
		writeJSON(w, 200, map[string]any{"ok": false, "error": msg})
	}
	modelsRes, err := withTimeout(r.Context(), base+"/models", http.MethodGet, nil)
	if err != nil {
		fail("could not reach upstream — check your connection")
		return
	}
	modelsRes.Body.Close()
	if modelsRes.StatusCode == 401 || modelsRes.StatusCode == 403 {
		fail("key rejected by upstream (401/403) — check the key")
		return
	}
	model := "big-pickle"
	if modelsRes.StatusCode >= 200 && modelsRes.StatusCode < 300 {
		// Re-fetch to parse the catalog (body already closed; do a fresh GET).
		if res2, err := withTimeout(r.Context(), base+"/models", http.MethodGet, nil); err == nil {
			var catalog struct {
				Data []struct {
					ID string `json:"id"`
				} `json:"data"`
			}
			if json.NewDecoder(res2.Body).Decode(&catalog) == nil {
				for _, m := range catalog.Data {
					if m.ID != "" && !strings.HasSuffix(m.ID, "-free") {
						model = m.ID
						break
					}
				}
				if model == "big-pickle" && len(catalog.Data) > 0 && catalog.Data[0].ID != "" {
					model = catalog.Data[0].ID
				}
			}
			res2.Body.Close()
		}
	}
	ping, err := withTimeout(r.Context(), base+"/chat/completions", http.MethodPost, map[string]any{
		"model": model, "messages": []any{map[string]any{"role": "user", "content": "ping"}},
		"max_tokens": 1, "stream": false,
	})
	if err != nil {
		fail("could not reach upstream — check your connection")
		return
	}
	defer ping.Body.Close()
	if ping.StatusCode == 401 {
		buf := make([]byte, 4096)
		n, _ := ping.Body.Read(buf)
		probe := string(buf[:n])
		if invalidKeyHints.MatchString(probe) && !quotaHints.MatchString(probe) {
			fail("key rejected by upstream — check the key")
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleCreateAccount(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	accounts := s.deps.Accounts.Read()
	// Zero-config: generate an id when the client doesn't send one
	// (e.g. the Connect dialog), instead of rejecting the request.
	if id, _ := body["id"].(string); strings.TrimSpace(id) == "" {
		prefix, _ := body["provider"].(string)
		prefix = strings.TrimSpace(prefix)
		if prefix == "" {
			prefix = "account"
		}
		body["id"] = nextAccountID(accounts, prefix)
	}
	acct, err := ValidateAccount(body)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	for _, a := range accounts {
		if a.ID == acct.ID {
			writeError(w, 409, fmt.Sprintf("account '%s' already exists", acct.ID))
			return
		}
	}
	// A native-web account needs its provider to route anywhere — auto-add the
	// preset if the user connected before adding the provider.
	ensureNativeProvider := func(preset ProviderConfig) {
		for _, p := range s.deps.Providers.Load() {
			if p.ID == preset.ID {
				return
			}
		}
		providers := append(s.deps.Providers.Load(), preset)
		s.deps.Providers.Save(providers)
		s.deps.Metrics.Record("settings", fmt.Sprintf("native %s provider preset added (auto, on account connect)", preset.ID))
	}
	switch acct.Provider {
	case QwenPreset().ID:
		ensureNativeProvider(QwenPreset())
	case DeepSeekPreset().ID:
		ensureNativeProvider(DeepSeekPreset())
	case ZaiPreset().ID:
		ensureNativeProvider(ZaiPreset())
	}
	accounts = append(accounts, acct)
	s.deps.Accounts.Write(accounts)
	s.deps.Pool.Replace(accounts)
	s.deps.Metrics.Record("account_added", fmt.Sprintf("account '%s' added", acct.ID))
	writeJSON(w, 201, map[string]any{"ok": true})
}

func (s *Server) handleUpdateAccount(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	body := decodeBody(r)
	accounts := s.deps.Accounts.Read()
	i := -1
	for n, a := range accounts {
		if a.ID == id {
			i = n
			break
		}
	}
	if i < 0 {
		writeError(w, 404, "account not found")
		return
	}
	// Empty apiKey on edit = keep the existing key (keys never reach the UI).
	// Explicit clearApiKey: true converts a keyed account to keyless.
	if clear, _ := body["clearApiKey"].(bool); clear {
		body["apiKey"] = ""
	} else if k, _ := body["apiKey"].(string); strings.TrimSpace(k) == "" {
		body["apiKey"] = accounts[i].APIKey
	}
	body["id"] = id
	acct, err := ValidateAccount(body)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	accounts[i] = acct
	s.deps.Accounts.Write(accounts)
	s.deps.Pool.Replace(accounts)
	s.deps.Metrics.Record("account_added", fmt.Sprintf("account '%s' updated", id))
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handlePatchAccount toggles per-account proxy routing.
func (s *Server) handlePatchAccount(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	body := decodeBody(r)
	accounts := s.deps.Accounts.Read()
	i := -1
	for n, a := range accounts {
		if a.ID == id {
			i = n
			break
		}
	}
	if i < 0 {
		writeError(w, 404, "account not found")
		return
	}
	if up, ok := body["useProxy"].(bool); ok {
		if up {
			accounts[i].UseProxy = nil // default: proxy on
		} else {
			accounts[i].UseProxy = boolPtr(false)
		}
		s.deps.Accounts.Write(accounts)
		s.deps.Pool.Replace(accounts)
	}
	useProxy := accounts[i].UseProxy == nil || *accounts[i].UseProxy
	writeJSON(w, 200, map[string]any{"ok": true, "useProxy": useProxy})
}

func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	accounts := s.deps.Accounts.Read()
	next := accounts[:0]
	for _, a := range accounts {
		if a.ID != id {
			next = append(next, a)
		}
	}
	if len(next) == len(accounts) {
		writeError(w, 404, "account not found")
		return
	}
	s.deps.Accounts.Write(next)
	s.deps.Pool.Replace(next)
	s.deps.Metrics.Record("account_removed", fmt.Sprintf("account '%s' removed", id))
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleResetAccount re-admits a key flagged invalid.
func (s *Server) handleResetAccount(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.deps.Pool.ClearInvalid(id)
	s.deps.Metrics.Record("account_added", fmt.Sprintf("account '%s' reset after invalid-key flag", id))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func findProvider(providers []ProviderConfig, protocol string) *ProviderConfig {
	for i := range providers {
		if providers[i].Protocol == protocol {
			return &providers[i]
		}
	}
	return nil
}

func nextAccountID(accounts []AccountConfig, prefix string) string {
	n := 1
	for {
		id := fmt.Sprintf("%s-%d", prefix, n)
		exists := false
		for _, a := range accounts {
			if a.ID == id {
				exists = true
				break
			}
		}
		if !exists {
			return id
		}
		n++
	}
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

func (s *Server) handleListProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.deps.Providers.Load())
}

func (s *Server) handleCreateProvider(w http.ResponseWriter, r *http.Request) {
	p, err := ValidateProviderInput(decodeBody(r))
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	providers := s.deps.Providers.Load()
	for _, x := range providers {
		if x.ID == p.ID {
			writeError(w, 409, fmt.Sprintf("provider '%s' already exists", p.ID))
			return
		}
	}
	providers = append(providers, p)
	s.deps.Providers.Save(providers)
	s.deps.Metrics.Record("settings", fmt.Sprintf("provider '%s' added", p.ID))
	writeJSON(w, 201, map[string]any{"ok": true})
}

func (s *Server) handleUpdateProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	body := decodeBody(r)
	body["id"] = id
	p, err := ValidateProviderInput(body)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	providers := s.deps.Providers.Load()
	i := -1
	for n, x := range providers {
		if x.ID == id {
			i = n
			break
		}
	}
	if i < 0 {
		writeError(w, 404, "provider not found")
		return
	}
	providers[i] = p
	s.deps.Providers.Save(providers)
	s.deps.Metrics.Record("settings", fmt.Sprintf("provider '%s' updated", id))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleDeleteProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	providers := s.deps.Providers.Load()
	if len(providers) <= 1 {
		writeError(w, 400, "cannot delete the last provider")
		return
	}
	next := providers[:0]
	for _, p := range providers {
		if p.ID != id {
			next = append(next, p)
		}
	}
	if len(next) == len(providers) {
		writeError(w, 404, "provider not found")
		return
	}
	s.deps.Providers.Save(next)
	s.deps.Metrics.Record("settings", fmt.Sprintf("provider '%s' removed", id))
	writeJSON(w, 200, map[string]any{"ok": true})
}

// presetRefresh compares defaultModel + modelMap keys and upgrades the stored
// preset when the bundled one moved on. Returns true when a refresh happened.
func presetRefresh(s *Server, providers []ProviderConfig, preset ProviderConfig, defOf func(ProviderConfig) (string, map[string]string)) ([]ProviderConfig, bool) {
	for i, p := range providers {
		if p.ID != preset.ID {
			continue
		}
		curDef, curMap := defOf(p)
		newDef, newMap := defOf(preset)
		curKeys, newKeys := sortedKeys(curMap), sortedKeys(newMap)
		if curDef != newDef || !equalStrings(curKeys, newKeys) {
			providers[i] = preset
			if p.Name != "" && p.Name != preset.Name {
				providers[i].Name = p.Name
			} else {
				providers[i].Name = preset.Name
			}
			s.deps.Providers.Save(providers)
			return providers, true
		}
		return providers, false
	}
	return providers, false
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (s *Server) handlePresetQwen(w http.ResponseWriter, r *http.Request) {
	preset := QwenPreset()
	providers := s.deps.Providers.Load()
	if _, refreshed := presetRefresh(s, providers, preset, func(p ProviderConfig) (string, map[string]string) {
		if p.Qwen == nil {
			return "", nil
		}
		return p.Qwen.DefaultModel, p.Qwen.ModelMap
	}); refreshed {
		s.deps.Metrics.Record("settings", "qwen provider models refreshed")
		writeJSON(w, 200, map[string]any{"ok": true, "upgraded": true, "provider": preset})
		return
	}
	for _, p := range providers {
		if p.ID == preset.ID {
			// Legacy self-hosted qwen2api entry (127.0.0.1:8765) upgrades to native.
			if strings.Contains(p.BaseURL, "8765") {
				for i := range providers {
					if providers[i].ID == preset.ID {
						providers[i] = preset
					}
				}
				s.deps.Providers.Save(providers)
				s.deps.Metrics.Record("settings", "qwen provider upgraded to native qwen-web")
				writeJSON(w, 200, map[string]any{"ok": true, "upgraded": true, "provider": preset})
				return
			}
			writeError(w, 409, "qwen provider already exists")
			return
		}
	}
	providers = append(providers, preset)
	s.deps.Providers.Save(providers)
	s.deps.Metrics.Record("settings", "native qwen provider preset added")
	writeJSON(w, 201, map[string]any{"ok": true, "provider": preset})
}

func (s *Server) handlePresetDeepSeek(w http.ResponseWriter, r *http.Request) {
	preset := DeepSeekPreset()
	providers := s.deps.Providers.Load()
	if _, refreshed := presetRefresh(s, providers, preset, func(p ProviderConfig) (string, map[string]string) {
		if p.DeepSeek == nil {
			return "", nil
		}
		return p.DeepSeek.DefaultModel, p.DeepSeek.ModelMap
	}); refreshed {
		s.deps.Metrics.Record("settings", "deepseek provider models refreshed")
		writeJSON(w, 200, map[string]any{"ok": true, "upgraded": true, "provider": preset})
		return
	}
	for _, p := range providers {
		if p.ID == preset.ID {
			writeError(w, 409, "deepseek provider already exists")
			return
		}
	}
	providers = append(providers, preset)
	s.deps.Providers.Save(providers)
	s.deps.Metrics.Record("settings", "native deepseek provider preset added")
	writeJSON(w, 201, map[string]any{"ok": true, "provider": preset})
}

func (s *Server) handlePresetOpenCodeZen(w http.ResponseWriter, r *http.Request) {
	providers := s.deps.Providers.Load()
	for _, p := range providers {
		if p.ID == "opencode-zen" {
			writeError(w, 409, "opencode-zen provider already exists")
			return
		}
	}
	zen := ProviderConfig{
		ID: "opencode-zen", Name: "OpenCode Zen",
		BaseURL: s.deps.Settings.Get().UpstreamBase,
		Models:  []string{"*"}, Enabled: true,
	}
	providers = append(providers, zen)
	s.deps.Providers.Save(providers)
	s.deps.Metrics.Record("settings", "opencode-zen provider restored")
	writeJSON(w, 200, map[string]any{"ok": true, "provider": zen})
}

func (s *Server) handlePresetZai(w http.ResponseWriter, r *http.Request) {
	preset := ZaiPreset()
	providers := s.deps.Providers.Load()
	if _, refreshed := presetRefresh(s, providers, preset, func(p ProviderConfig) (string, map[string]string) {
		if p.Zai == nil {
			return "", nil
		}
		return p.Zai.DefaultModel, p.Zai.ModelMap
	}); refreshed {
		s.deps.Metrics.Record("settings", "z.ai provider models refreshed")
		writeJSON(w, 200, map[string]any{"ok": true, "upgraded": true, "provider": preset})
		return
	}
	for _, p := range providers {
		if p.ID == preset.ID {
			writeError(w, 409, "z.ai provider already exists")
			return
		}
	}
	providers = append(providers, preset)
	s.deps.Providers.Save(providers)
	s.deps.Metrics.Record("settings", "native z.ai provider preset added")
	writeJSON(w, 201, map[string]any{"ok": true, "provider": preset})
}

// handleTestProvider probes a provider: native web protocols validate the
// first account's credential, OpenAI-compatible ones hit /models.
func (s *Server) handleTestProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var p *ProviderConfig
	for _, x := range s.deps.Providers.Load() {
		if x.ID == id {
			c := x
			p = &c
			break
		}
	}
	if p == nil {
		writeError(w, 404, "provider not found")
		return
	}
	account := s.deps.Pool.Acquire(p.ID)
	if account != nil {
		defer s.deps.Pool.Release(account.ID)
	}
	countModels := func(m map[string]string) int { return len(m) + 1 }
	switch p.Protocol {
	case "qwen-web":
		if account == nil || account.APIKey == "" {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "no Qwen account connected — use Connect Qwen account"})
			return
		}
		v := s.deps.WebAuth.ValidateQwen(r.Context(), p.BaseURL, account.APIKey, derefStr(account.Cookies))
		if !v.OK {
			writeJSON(w, 200, map[string]any{"ok": false, "error": v.Error})
			return
		}
		n := 1
		if p.Qwen != nil {
			n = countModels(p.Qwen.ModelMap)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "models": n})
		return
	case "deepseek-web":
		if account == nil || account.APIKey == "" {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "no DeepSeek account connected — use Connect DeepSeek account"})
			return
		}
		v := s.deps.WebAuth.ValidateDeepSeek(r.Context(), p.BaseURL, account.APIKey, derefStr(account.Cookies))
		if !v.OK {
			writeJSON(w, 200, map[string]any{"ok": false, "error": v.Error})
			return
		}
		n := 1
		if p.DeepSeek != nil {
			n = countModels(p.DeepSeek.ModelMap)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "models": n})
		return
	case "zai-web":
		if account == nil || account.APIKey == "" {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "no Z.ai account connected — use Connect Z.ai account"})
			return
		}
		v := s.deps.WebAuth.ValidateZai(r.Context(), p.BaseURL, account.APIKey)
		if !v.OK {
			writeJSON(w, 200, map[string]any{"ok": false, "error": v.Error})
			return
		}
		n := 1
		if p.Zai != nil {
			n = countModels(p.Zai.ModelMap)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "models": n})
		return
	}
	tctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodGet, strings.TrimRight(p.BaseURL, "/")+"/models", nil)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()[:min(160, len(err.Error()))]})
		return
	}
	if account != nil && account.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+account.APIKey)
	}
	rt := s.deps.Rotator.RoundTripperFor(s.deps.Rotator.Current(), s.deps.Rotator.CurrentFamily())
	resp, err := (&http.Client{Transport: rt}).Do(req)
	if err != nil {
		msg := err.Error()
		writeJSON(w, 200, map[string]any{"ok": false, "error": msg[:min(160, len(msg))]})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeJSON(w, 200, map[string]any{"ok": false, "error": fmt.Sprintf("HTTP %d", resp.StatusCode)})
		return
	}
	var catalog struct {
		Data []any `json:"data"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&catalog)
	writeJSON(w, 200, map[string]any{"ok": true, "models": len(catalog.Data)})
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ---------------------------------------------------------------------------
// proxies
// ---------------------------------------------------------------------------

func (s *Server) handleListProxies(w http.ResponseWriter, r *http.Request) {
	// Bare array of {url, healthy} for the dashboard.
	st := s.deps.Rotator.Status()
	healthByURL := map[string]bool{}
	for _, h := range st.Health {
		healthByURL[h.Proxy] = h.Healthy
	}
	urls := s.deps.Proxies.Read()
	out := make([]map[string]any, 0, len(urls))
	for _, u := range urls {
		healthy, ok := healthByURL[u]
		if !ok {
			healthy = true // unchecked = assumed healthy
		}
		out = append(out, map[string]any{"url": u, "healthy": healthy})
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleSetProxies(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	var clean []string
	if raw, ok := body["proxies"].([]any); ok {
		for _, p := range raw {
			if str, ok := p.(string); ok && strings.TrimSpace(str) != "" {
				clean = append(clean, strings.TrimSpace(str))
			}
		}
	}
	s.deps.Proxies.Write(clean)
	s.deps.Rotator.SetProxies(clean)
	s.deps.Metrics.Record("proxy_added", fmt.Sprintf("proxy pool replaced (%d entries)", len(clean)))
	writeJSON(w, 200, map[string]any{"ok": true, "count": len(clean)})
}

func (s *Server) handleDeleteProxy(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("proxy")
	next := []string{}
	for _, p := range s.deps.Proxies.Read() {
		if p != target {
			next = append(next, p)
		}
	}
	s.deps.Proxies.Write(next)
	s.deps.Rotator.SetProxies(next)
	s.deps.Metrics.Record("proxy_removed", fmt.Sprintf("proxy removed (%d left)", len(next)))
	writeJSON(w, 200, map[string]any{"ok": true, "count": len(next)})
}

func (s *Server) handleRotate(w http.ResponseWriter, r *http.Request) {
	s.deps.Rotator.Rotate()
	s.deps.Metrics.Rotated(s.deps.Rotator.EgressLabel())
	st := s.deps.Rotator.Status()
	writeJSON(w, 200, map[string]any{
		"ok": true, "proxies": st.Proxies, "currentIndex": st.CurrentIndex,
		"current": st.Current, "rotations": st.Rotations,
	})
}

// handleTestProxies probes a list of proxies without adding them.
func (s *Server) handleTestProxies(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	var list []string
	if raw, ok := body["proxies"].([]any); ok {
		for _, p := range raw {
			if str, ok := p.(string); ok {
				list = append(list, str)
			}
		}
	}
	if len(list) > 50 {
		list = list[:50]
	}
	type result struct {
		Proxy string `json:"proxy"`
		OK    bool   `json:"ok"`
	}
	results := make([]result, len(list))
	for i, proxy := range list {
		results[i] = result{Proxy: proxy, OK: s.deps.Scraper.TestProxy(proxy)}
	}
	writeJSON(w, 200, map[string]any{"results": results})
}

// handleCheckProxies manually probes proxy health (selection or all).
func (s *Server) handleCheckProxies(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	all := s.deps.Proxies.Read()
	var list []string
	if raw, ok := body["proxies"].([]any); ok && len(raw) > 0 {
		allowed := map[string]bool{}
		for _, p := range all {
			allowed[p] = true
		}
		for _, p := range raw {
			if str, ok := p.(string); ok && allowed[str] {
				list = append(list, str)
			}
		}
	} else {
		list = all
	}
	s.deps.Rotator.CheckProxies(list)
	s.deps.Metrics.Record("settings", fmt.Sprintf("manual proxy health check: %d checked", len(list)))
	writeJSON(w, 200, map[string]any{"ok": true, "checked": len(list), "health": s.deps.Rotator.Status().Health})
}

// ---------------------------------------------------------------------------
// proxy scraper
// ---------------------------------------------------------------------------

func (s *Server) handleListScraperProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"providers": s.deps.Scraper.Load()})
}

func (s *Server) handleScraperStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.deps.ScraperJob.Status())
}

func (s *Server) handleScraperRun(w http.ResponseWriter, r *http.Request) {
	if !s.deps.ScraperJob.Start() {
		writeError(w, 409, "a scrape is already running")
		return
	}
	writeJSON(w, 202, map[string]any{"ok": true, "started": true})
}

// ---- Z.ai device tokens ----

func (s *Server) handleZaiTokensStatus(w http.ResponseWriter, r *http.Request) {
	count := 0
	if s.deps.ZaiTokens != nil {
		count = s.deps.ZaiTokens.Count()
	}
	writeJSON(w, 200, map[string]any{
		"count":       count,
		"collecting":  zaiCollectRunning.Load(),
		"collectLog":  zaiCollectLog(),
	})
}

func (s *Server) handleZaiTokensClear(w http.ResponseWriter, r *http.Request) {
	if s.deps.ZaiTokens != nil {
		if err := s.deps.ZaiTokens.Clear(); err != nil {
			writeError(w, 500, err.Error())
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// toInt converts a decoded JSON number (json.Number via UseNumber,
// float64) or string to int.
func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return int(i), true
		}
	case float64:
		return int(n), true
	case int:
		return n, true
	case string:
		if i, err := strconv.Atoi(n); err == nil {
			return i, true
		}
	}
	return 0, false
}

func (s *Server) handleZaiTokensCollect(w http.ResponseWriter, r *http.Request) {
	if zaiCollectRunning.Load() {
		writeError(w, 409, "collection already running")
		return
	}
	// Options come from a JSON body {tokens, batches, parallel, headed,
	// blockTrackers, unsafe, count} or query params. Legacy ?count= still
	// means a single batch of exactly that many tokens.
	opts := ZaiCollectOptions{}
	body := decodeBody(r)
	if len(body) > 0 {
		if v, ok := toInt(body["tokens"]); ok {
			opts.Tokens = v
		}
		if v, ok := toInt(body["batches"]); ok {
			opts.Batches = v
		}
		if v, ok := toInt(body["parallel"]); ok {
			opts.Parallel = v
		}
		if v, ok := body["headed"].(bool); ok {
			opts.Headed = v
		}
		if v, ok := body["blockTrackers"].(bool); ok {
			opts.BlockTrackers = v
		}
		if v, ok := body["unsafe"].(bool); ok {
			opts.Unsafe = v
		}
		if v, ok := toInt(body["count"]); ok {
			opts.Count = v
		}
	}
	if q := r.URL.Query().Get("count"); q != "" {
		opts.Count = queryInt(r, "count", 20, 1, 200)
	}
	if opts.Count <= 0 && opts.Tokens <= 0 && opts.Batches <= 0 {
		// No options at all: legacy quick collect of 20.
		opts.Count = 20
	}
	if !RunZaiCollectOpts(opts) {
		writeError(w, 409, "collection already running")
		return
	}
	writeJSON(w, 202, map[string]any{"ok": true, "started": true})
}

var scraperFormats = map[string]bool{"text": true, "geonode": true, "spys": true, "fpl": true, "proxynova": true}

func (s *Server) handleCreateScraperProvider(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	name, _ := body["name"].(string)
	name = strings.TrimSpace(name)
	urlStr, _ := body["url"].(string)
	urlStr = strings.TrimSpace(urlStr)
	format, _ := body["format"].(string)
	if !scraperFormats[format] {
		format = "text"
	}
	if name == "" || urlStr == "" {
		writeError(w, 400, "name and url are required")
		return
	}
	if _, err := http.NewRequest(http.MethodGet, urlStr, nil); err != nil {
		_ = err
	}
	if u, err := parseURL(urlStr); err != nil || u == "" {
		writeError(w, 400, "url is not valid")
		return
	}
	providers := s.deps.Scraper.Load()
	id := fmt.Sprintf("custom-%d", time.Now().UnixMilli())
	providers = append(providers, ScraperProvider{ID: id, Name: name, URL: urlStr, Format: format, Enabled: true})
	s.deps.Scraper.Save(providers)
	s.deps.Metrics.Record("proxy_added", fmt.Sprintf("scraper provider '%s' added", name))
	writeJSON(w, 201, map[string]any{"ok": true, "id": id})
}

func (s *Server) handleUpdateScraperProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	body := decodeBody(r)
	providers := s.deps.Scraper.Load()
	i := -1
	for n, p := range providers {
		if p.ID == id {
			i = n
			break
		}
	}
	if i < 0 {
		writeError(w, 404, "provider not found")
		return
	}
	if name, _ := body["name"].(string); strings.TrimSpace(name) != "" {
		providers[i].Name = strings.TrimSpace(name)
	}
	if urlStr, _ := body["url"].(string); strings.TrimSpace(urlStr) != "" {
		if u, err := parseURL(strings.TrimSpace(urlStr)); err != nil || u == "" {
			writeError(w, 400, "url is not valid")
			return
		}
		providers[i].URL = strings.TrimSpace(urlStr)
	}
	if format, _ := body["format"].(string); scraperFormats[format] {
		providers[i].Format = format
	}
	if enabled, ok := body["enabled"].(bool); ok {
		providers[i].Enabled = enabled
	}
	s.deps.Scraper.Save(providers)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleDeleteScraperProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	providers := s.deps.Scraper.Load()
	next := providers[:0]
	for _, p := range providers {
		if p.ID != id {
			next = append(next, p)
		}
	}
	if len(next) == len(providers) {
		writeError(w, 404, "provider not found")
		return
	}
	s.deps.Scraper.Save(next)
	s.deps.Metrics.Record("proxy_removed", fmt.Sprintf("scraper provider '%s' removed", id))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func bytesReader(b []byte) io.Reader {
	if len(b) == 0 {
		return nil
	}
	return bytes.NewReader(b)
}

func parseURL(s string) (string, error) {
	u, err := url.ParseRequestURI(s)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

func redactSettings(st Settings) map[string]any {
	m := map[string]any{
		"port": st.Port, "upstreamBase": st.UpstreamBase,
		"maxRetries": st.MaxRetries, "retryBaseMs": st.RetryBaseMs, "retryMaxMs": st.RetryMaxMs,
		"defaultCooldownMs": st.DefaultCooldownMs, "requestTimeoutMs": st.RequestTimeoutMs,
		"adminToken": "••••••••", "proxyHealthCheck": st.ProxyHealthCheck,
		"proxyHealthIntervalMs": st.ProxyHealthIntervalMs, "egressFamily": st.EgressFamily,
		"quota5hLimit": st.Quota5hLimit, "tokenSaver": st.TokenSaver,
		"tokenSaverMaxChars": st.TokenSaverMaxChars, "autoScrape": st.AutoScrape,
		"autoScrapeIntervalHours": st.AutoScrapeIntervalHours, "routingStrategy": st.RoutingStrategy,
		"queueMaxWaitMs": st.QueueMaxWaitMs, "alertWebhookUrl": "••••••••",
		"accountConcurrency": st.AccountConcurrency, "proxyAutoDropFails": st.ProxyAutoDropFails,
		"modelFallbacks": st.ModelFallbacks, "errorSpikeThreshold": st.ErrorSpikeThreshold,
		"errorSpikeWindowMin": st.ErrorSpikeWindowMin, "errorSpikeMinRequests": st.ErrorSpikeMinRequests,
		"clientTokens": []string{}, "modelTimeouts": st.ModelTimeouts,
		"logFile": st.LogFile, "logMaxMb": st.LogMaxMb, "logKeep": st.LogKeep,
		"shutdownDrainMs": st.ShutdownDrainMs,
	}
	if st.AdminToken == "" {
		m["adminToken"] = ""
	}
	if st.AlertWebhookUrl == "" {
		m["alertWebhookUrl"] = ""
	}
	return m
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	// Bare settings object for the dashboard.
	writeJSON(w, 200, redactSettings(s.deps.Settings.Get()))
}

func (s *Server) handlePostSettings(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	patch := map[string]any{}
	// Whitelisted scalar keys pass straight through.
	for _, k := range []string{"upstreamBase", "maxRetries", "retryBaseMs", "retryMaxMs",
		"defaultCooldownMs", "requestTimeoutMs", "adminToken", "quota5hLimit",
		"proxyHealthIntervalMs", "tokenSaverMaxChars", "autoScrapeIntervalHours",
		"queueMaxWaitMs", "accountConcurrency", "proxyAutoDropFails",
		"logMaxMb", "logKeep", "shutdownDrainMs",
		"errorSpikeThreshold", "errorSpikeWindowMin", "errorSpikeMinRequests"} {
		if v, ok := body[k]; ok {
			patch[k] = v
		}
	}
	for _, k := range []string{"proxyHealthCheck", "tokenSaver", "autoScrape"} {
		if v, ok := body[k].(bool); ok {
			patch[k] = v
		}
	}
	if v, _ := body["egressFamily"].(string); v == "auto" || v == "4" || v == "6" {
		patch["egressFamily"] = v
	}
	if v, _ := body["routingStrategy"].(string); v == "priority" || v == "latency" {
		patch["routingStrategy"] = v
	}
	if v, _ := body["alertWebhookUrl"].(string); v != "" {
		patch["alertWebhookUrl"] = v
	}
	if v, _ := body["logFile"].(string); body["logFile"] != nil {
		patch["logFile"] = strings.TrimSpace(v)
	}
	if v, ok := body["modelFallbacks"]; ok && v != nil {
		patch["modelFallbacks"] = v
	}
	if v, ok := body["modelTimeouts"]; ok && v != nil {
		patch["modelTimeouts"] = v
	}
	// Client tokens: replaced only when the dashboard sends a new string.
	if clear, _ := body["clearClientTokens"].(bool); clear {
		patch["clientTokens"] = []string{}
	} else if v, _ := body["clientTokens"].(string); strings.TrimSpace(v) != "" {
		var toks []string
		for _, t := range strings.Split(v, ",") {
			if strings.TrimSpace(t) != "" {
				toks = append(toks, strings.TrimSpace(t))
			}
		}
		patch["clientTokens"] = toks
	}
	// Port changes are saved but only take effect after a restart.
	portChanged := false
	if v, ok := toFloat(body["port"]); ok && body["port"] != nil {
		patch["port"] = int(v)
		portChanged = int(v) != s.deps.Settings.Get().Port
	}
	next := s.deps.Settings.Save(patch)
	// Apply live without restart.
	s.deps.Rotator.StopHealthChecks()
	if next.ProxyHealthCheck {
		s.deps.Rotator.StartHealthChecks(next.ProxyHealthIntervalMs)
	}
	s.deps.Rotator.ConfigureEgress(next.EgressFamily)
	if s.deps.ReinitFileLogger != nil {
		s.deps.ReinitFileLogger()
	}
	s.deps.Metrics.Record("settings", "settings updated via dashboard")
	writeJSON(w, 200, map[string]any{
		"ok": true, "restartRequired": portChanged,
		"settings": redactSettings(next), "clientTokensCount": len(next.ClientTokens),
	})
}

// ---------------------------------------------------------------------------
// backup / restore
// ---------------------------------------------------------------------------

func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"opencode-max-backup-%s.json\"", time.Now().Format("2006-01-02")))
	var accounts []AccountConfig
	func() {
		defer func() { _ = recover() }()
		accounts = s.deps.Accounts.Read()
	}()
	if accounts == nil {
		accounts = []AccountConfig{}
	}
	writeJSON(w, 200, map[string]any{
		"version": 1, "exportedAt": time.Now().UTC().Format(time.RFC3339),
		"accounts": accounts, "providers": s.deps.Providers.Load(),
		"scraperProviders": s.deps.Scraper.Load(), "settings": s.deps.Settings.Get(),
	})
}

func (s *Server) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	bad := func(msg string) {
		writeError(w, 400, msg)
	}

	var accounts []AccountConfig
	if v, ok := body["accounts"]; ok && v != nil {
		raw, ok := v.([]any)
		if !ok {
			bad("accounts must be an array")
			return
		}
		for _, a := range raw {
			m, ok := a.(map[string]any)
			if !ok {
				bad("invalid account entry")
				return
			}
			acct, err := ValidateAccount(m)
			if err != nil {
				bad("invalid account: " + err.Error())
				return
			}
			accounts = append(accounts, acct)
		}
	}

	var providers []ProviderConfig
	if v, ok := body["providers"]; ok && v != nil {
		raw, ok := v.([]any)
		if !ok {
			bad("providers must be an array")
			return
		}
		for _, p := range raw {
			m, ok := p.(map[string]any)
			if !ok {
				bad("invalid provider entry")
				return
			}
			prov, err := ValidateProviderInput(m)
			if err != nil {
				bad("invalid provider: " + err.Error())
				return
			}
			providers = append(providers, prov)
		}
	}

	var scraperProviders []ScraperProvider
	if v, ok := body["scraperProviders"]; ok && v != nil {
		raw, ok := v.([]any)
		if !ok {
			bad("scraperProviders must be an array")
			return
		}
		for _, p := range raw {
			m, ok := p.(map[string]any)
			if !ok {
				bad("invalid scraper provider entry")
				return
			}
			id, _ := m["id"].(string)
			urlStr, _ := m["url"].(string)
			if id == "" || urlStr == "" {
				bad("invalid scraper provider entry")
				return
			}
			if u, err := parseURL(urlStr); err != nil || u == "" {
				bad("invalid scraper provider url: " + urlStr)
				return
			}
			name, _ := m["name"].(string)
			if name == "" {
				name = id
			}
			format, _ := m["format"].(string)
			if !scraperFormats[format] {
				format = "text"
			}
			enabled, _ := m["enabled"].(bool)
			if _, ok := m["enabled"]; !ok {
				enabled = true
			}
			scraperProviders = append(scraperProviders, ScraperProvider{ID: id, Name: name, URL: urlStr, Format: format, Enabled: enabled})
		}
	}

	// All sections validated — apply.
	if accounts != nil {
		s.deps.Accounts.Write(accounts)
		s.deps.Pool.Replace(accounts)
	}
	if providers != nil {
		s.deps.Providers.Save(providers)
	}
	if scraperProviders != nil {
		s.deps.Scraper.Save(scraperProviders)
	}
	if st, ok := body["settings"].(map[string]any); ok && st != nil {
		s.deps.Settings.Save(st)
	}
	s.deps.Metrics.Record("settings", "configuration restored from backup")
	writeJSON(w, 200, map[string]any{"ok": true})
}
