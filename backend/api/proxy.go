package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": message, "status": status}})
}

func decodeBody(r *http.Request) map[string]any {
	if r.Body == nil {
		return map[string]any{}
	}
	defer r.Body.Close()
	var m map[string]any
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		return map[string]any{}
	}
	return m
}

// ---------------------------------------------------------------------------
// /health, /v1/accounts, /v1/rotate
// ---------------------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	type provInfo struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Enabled bool   `json:"enabled"`
	}
	providers := s.deps.Providers.Load()
	info := make([]provInfo, 0, len(providers))
	for _, p := range providers {
		info = append(info, provInfo{ID: p.ID, Name: p.Name, Enabled: p.Enabled})
	}
	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"providers": info,
		"ip":        s.deps.Rotator.Status(),
		"accounts":  len(s.deps.Pool.Status()),
	})
}

// handlePrometheus serves the Prometheus exposition format.
func (s *Server) handlePrometheus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.WriteHeader(200)
	_, _ = io.WriteString(w, s.deps.Metrics.Prometheus())
}

// handleV1Accounts exposes the keyless pool status.
func (s *Server) handleV1Accounts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"accounts": s.deps.Pool.Status(),
		"ip":       s.deps.Rotator.Status(),
	})
}

// handleV1Rotate manually rotates egress, e.g. curl -X POST localhost:8080/v1/rotate
func (s *Server) handleV1Rotate(w http.ResponseWriter, r *http.Request) {
	s.deps.Rotator.Rotate()
	st := s.deps.Rotator.Status()
	writeJSON(w, 200, map[string]any{
		"ok":           true,
		"proxies":      st.Proxies,
		"currentIndex": st.CurrentIndex,
		"current":      st.Current,
		"rotations":    st.Rotations,
	})
}

// ---------------------------------------------------------------------------
// /v1/models — aggregated, cached 60s
// ---------------------------------------------------------------------------

const modelsCacheTTL = 60 * time.Second

type modelsCache struct {
	mu   sync.Mutex
	at   time.Time
	data []any
}

func (s *Server) handleV1Models(w http.ResponseWriter, r *http.Request) {
	if cached := s.getModelsCache(); cached != nil {
		writeJSON(w, 200, map[string]any{"object": "list", "data": cached})
		return
	}
	data := s.aggregateModels(r.Context())
	s.setModelsCache(data)
	writeJSON(w, 200, map[string]any{"object": "list", "data": data})
}

func (s *Server) getModelsCache() []any {
	s.modelsMu.mu.Lock()
	defer s.modelsMu.mu.Unlock()
	if s.modelsMu.data != nil && time.Since(s.modelsMu.at) < modelsCacheTTL {
		return s.modelsMu.data
	}
	return nil
}

func (s *Server) setModelsCache(data []any) {
	s.modelsMu.mu.Lock()
	defer s.modelsMu.mu.Unlock()
	s.modelsMu.at = time.Now()
	s.modelsMu.data = data
}

// aggregateModels collects model lists from every enabled provider,
// deduplicated. Native web protocols synthesize from their config.
func (s *Server) aggregateModels(ctx context.Context) []any {
	seen := map[string]bool{}
	var data []any
	for _, p := range s.deps.Providers.Load() {
		if !p.Enabled {
			continue
		}
		switch p.Protocol {
		case "qwen-web":
			def := "qwen3.7-plus"
			var ids []string
			if p.Qwen != nil {
				def = p.Qwen.DefaultModel
				for id := range p.Qwen.ModelMap {
					ids = append(ids, id)
				}
			}
			ids = append(ids, def)
			for _, id := range ids {
				if id != "" && !seen[id] {
					seen[id] = true
					data = append(data, map[string]any{"id": id, "object": "model", "owned_by": "qwen"})
				}
			}
			continue
		case "deepseek-web":
			def := "deepseek-chat"
			var ids []string
			if p.DeepSeek != nil {
				def = p.DeepSeek.DefaultModel
				for id := range p.DeepSeek.ModelMap {
					ids = append(ids, id)
				}
			}
			ids = append(ids, def)
			for _, id := range ids {
				if id != "" && !seen[id] {
					seen[id] = true
					data = append(data, map[string]any{"id": id, "object": "model", "owned_by": "deepseek"})
				}
			}
			continue
		case "zai-web":
			def := "glm-5.3-flash"
			var ids []string
			if p.Zai != nil {
				def = p.Zai.DefaultModel
				for id := range p.Zai.ModelMap {
					ids = append(ids, id)
				}
			}
			ids = append(ids, def)
			for _, id := range ids {
				if id != "" && !seen[id] {
					seen[id] = true
					data = append(data, map[string]any{"id": id, "object": "model", "owned_by": "zai"})
				}
			}
			continue
		}
		// OpenAI-compatible: fetch the upstream /models catalog (15s cap).
		// A dead provider is skipped — it must not fail the whole list.
		acct := s.deps.Pool.Acquire(p.ID)
		func() {
			if acct != nil {
				defer s.deps.Pool.Release(acct.ID)
			}
			tctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(tctx, http.MethodGet, strings.TrimRight(p.BaseURL, "/")+"/models", nil)
			if err != nil {
				return
			}
			if acct != nil && acct.APIKey != "" {
				req.Header.Set("Authorization", "Bearer "+acct.APIKey)
			}
			rt := s.deps.Rotator.RoundTripperFor(s.deps.Rotator.Current(), s.deps.Rotator.CurrentFamily())
			client := &http.Client{Transport: rt}
			resp, err := client.Do(req)
			if err != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
				if resp != nil {
					resp.Body.Close()
				}
				return
			}
			defer resp.Body.Close()
			var catalog struct {
				Data []map[string]any `json:"data"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&catalog); err != nil {
				return
			}
			for _, m := range catalog.Data {
				id, _ := m["id"].(string)
				if id != "" && !seen[id] {
					seen[id] = true
					data = append(data, m)
				}
			}
		}()
	}
	if data == nil {
		data = []any{}
	}
	return data
}

// ---------------------------------------------------------------------------
// /v1/* proxy with SSE streaming
// ---------------------------------------------------------------------------

// streamResult copies an upstream result to the client, flushing after every
// chunk so SSE streams stay live. Hop-by-hop headers are stripped.
func streamResult(w http.ResponseWriter, result ForwardResult) {
	for k, v := range result.Headers {
		switch strings.ToLower(k) {
		case "content-encoding", "content-length", "transfer-encoding", "connection":
			continue
		}
		w.Header().Set(k, v)
	}
	w.WriteHeader(result.Status)
	if result.Body == nil {
		return
	}
	defer result.Body.Close()
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := result.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

// handleProxy forwards any /v1/* request through the upstream client
// (account selection, retry, cross-provider failover).
func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	zenPath := strings.TrimPrefix(r.URL.Path, "/v1")
	if zenPath == "" {
		zenPath = "/"
	}
	var body []byte
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		var err error
		body, err = io.ReadAll(r.Body)
		if err != nil {
			writeError(w, 400, "could not read request body")
			return
		}
	}
	r.Body.Close()

	providers := s.deps.Providers.Load()
	provider := MatchProvider(providers, ExtractModel(body))
	if provider == nil {
		provider = DefaultProvider(providers)
	}
	if provider == nil {
		writeError(w, 503, "no providers enabled — add one in the dashboard")
		return
	}

	headers := map[string]string{}
	for k, v := range r.Header {
		headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	query := ""
	if r.URL.RawQuery != "" {
		query = "?" + r.URL.RawQuery
	}

	// r.Context() is cancelled when the client disconnects, which aborts the
	// upstream fetch — the Go equivalent of abortOnClientClose.
	result, err := s.deps.Upstream.Forward(ForwardRequest{
		Method:         r.Method,
		Path:           zenPath,
		Query:          query,
		Headers:        headers,
		Body:           body,
		Provider:       provider.ID,
		AllowAnonymous: true,
		Ctx:            r.Context(),
	})
	if err != nil {
		if pe, ok := err.(*ProviderExhaustedError); ok {
			writeError(w, 502, pe.Msg)
			return
		}
		if se, ok := err.(interface{ StatusCode() int }); ok {
			writeError(w, se.StatusCode(), err.Error())
			return
		}
		writeError(w, 502, err.Error())
		return
	}
	streamResult(w, result)
}

// ---------------------------------------------------------------------------
// /api/playground/chat — dashboard-only model verification
// ---------------------------------------------------------------------------

// handlePlaygroundChat lets the dashboard chat with any connected model
// through the same upstream pipeline as /v1/chat/completions.
func (s *Server) handlePlaygroundChat(w http.ResponseWriter, r *http.Request) {
	body := decodeBody(r)
	model, _ := body["model"].(string)
	model = strings.TrimSpace(model)
	if model == "" {
		writeError(w, 400, "model is required")
		return
	}
	messages, _ := body["messages"].([]any)
	if messages == nil {
		messages = []any{}
	}
	bodyText, _ := json.Marshal(map[string]any{"model": model, "messages": messages, "stream": true})

	result, err := s.deps.Upstream.Forward(ForwardRequest{
		Method:         http.MethodPost,
		Path:           "/chat/completions",
		Query:          "",
		Headers:        map[string]string{"content-type": "application/json"},
		Body:           bodyText,
		AllowAnonymous: true,
		Ctx:            r.Context(),
	})
	if err != nil {
		if pe, ok := err.(*ProviderExhaustedError); ok {
			writeError(w, 502, pe.Msg)
			return
		}
		writeError(w, 502, err.Error())
		return
	}
	streamResult(w, result)
}
