// Package qwen implements the chat.qwen.ai private web API client.
//
// Protocol:
//  1. POST /api/v2/chats/new -> { success, data: { id } }
//  2. POST /api/v2/chat/completions?chat_id=<id> (SSE) with a single
//     flattened user message; phases: think / thinking_summary (reasoning),
//     answer (content).
//  3. Best-effort chat cleanup afterwards.
//
// Auth: the account credential is the `token` from chat.qwen.ai localStorage,
// sent as Authorization: Bearer with browser-like headers (logged-in). With no
// credential, Aliyun Baxia WAF tokens are used instead (guest mode).
//
// Risk-control responses (FAIL_SYS_USER_VALIDATE, RGV587_ERROR, captcha)
// arrive as HTTP 200 JSON instead of an event stream and are surfaced as 429s
// so the pool parks the account in cooldown instead of burning it.
package qwen

import (
	"bufio"
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// BaxiaVersion is the Aliyun BAFIA WAF token version sent as bx-v.
const BaxiaVersion = "2.5.36"

// defaultWuURL is Alibaba's endpoint that issues T2gA umid tokens.
const defaultWuURL = "https://sg-wum.alibaba.com/w/wu.json"

// bxUmidTTL mirrors the 4-minute cache in the reference implementation.
const bxUmidTTL = 4 * time.Minute

var (
	umidRe     = regexp.MustCompile(`umx\.wu\('([^']+)'\)`)
	quotedRe   = regexp.MustCompile(`'([^']+)'`)
	t2gAPrefix = regexp.MustCompile(`(?i)^T2gA`)
	riskRe     = regexp.MustCompile(`(?i)FAIL_SYS_USER_VALIDATE|RGV587_ERROR|captcha|verification`)
)

// QwenError is an upstream-facing error carrying the HTTP status the caller
// should surface (e.g. 429 for risk control, 401 for rejected tokens).
type QwenError struct {
	Message string
	Status  int
}

func (e *QwenError) Error() string { return e.Message }

// NewQwenError builds a *QwenError.
func NewQwenError(message string, status int) *QwenError {
	return &QwenError{Message: message, Status: status}
}

// Message is one OpenAI-format chat message. Content is either a string or a
// slice of content parts (each a map/struct with a "text" field).
type Message struct {
	Role    string
	Content any
}

// ContentPart is a single structured content part (e.g. {type:"text", text:"..."}).
type ContentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// Client talks to the Qwen web API.
type Client struct {
	// BaseURL is the Qwen web origin, e.g. https://chat.qwen.ai.
	BaseURL string
	// HTTP is the underlying client; defaults to one with a 90s timeout.
	HTTP *http.Client
	// WuURL overrides the Baxia umid endpoint (tests point it at a mock).
	WuURL string

	mu       sync.Mutex
	umid     string
	umidTime time.Time
}

// NewClient returns a Client for baseURL.
func NewClient(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 90 * time.Second},
		WuURL:   defaultWuURL,
	}
}

func newUUID() string {
	var b [16]byte
	if _, err := crand.Read(b[:]); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// chatMode returns "normal" for logged-in accounts, "guest" otherwise.
func chatMode(credential string) string {
	if strings.TrimSpace(credential) != "" {
		return "normal"
	}
	return "guest"
}

// baxiaFingerprint builds a random browser fingerprint for the bx-ua token.
func baxiaFingerprint() map[string]any {
	platforms := []string{"Win32", "Linux x86_64", "MacIntel"}
	languages := []string{"en-US", "zh-CN", "en-GB"}
	renderers := []string{
		"ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)",
		"ANGLE (NVIDIA, NVIDIA GeForce GTX 1080, OpenGL 4.6)",
		"ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.6)",
	}
	cf := make([]byte, 16)
	if _, err := crand.Read(cf); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	r := renderers[rand.IntN(len(renderers))]
	if len(r) > 20 {
		r = r[:20]
	}
	dms := []int{4, 8, 16, 32}
	tos := []int{-480, -300, 0, 60, 480}
	prs := []float64{1, 1.25, 1.5, 2}
	return map[string]any{
		"p":  platforms[rand.IntN(len(platforms))],
		"l":  languages[rand.IntN(len(languages))],
		"hc": 4 + rand.IntN(12),
		"dm": dms[rand.IntN(len(dms))],
		"to": tos[rand.IntN(len(tos))],
		"sw": 1920 + rand.IntN(200),
		"sh": 1080 + rand.IntN(100),
		"cd": 24,
		"pr": prs[rand.IntN(len(prs))],
		"wf": r,
		"cf": hex.EncodeToString(cf),
		"af": fmt.Sprintf("%.14f", 124.04347527516074+rand.Float64()*0.001),
		"ts": time.Now().UnixMilli(),
		"r":  rand.Float64(),
	}
}

// baxiaUA returns bx-ua = version (dots removed) + "!" + base64(fingerprint JSON).
func baxiaUA() string {
	j, _ := json.Marshal(baxiaFingerprint())
	return strings.ReplaceAll(BaxiaVersion, ".", "") + "!" + base64.StdEncoding.EncodeToString(j)
}

// baxiaUmidToken fetches the T2gA umid token, cached for 4 minutes.
func (c *Client) baxiaUmidToken(ctx context.Context) string {
	c.mu.Lock()
	if c.umid != "" && time.Since(c.umidTime) < bxUmidTTL {
		u := c.umid
		c.mu.Unlock()
		return u
	}
	c.mu.Unlock()

	token := ""
	func() {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.WuURL, nil)
		if err != nil {
			return
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if err != nil {
			return
		}
		text := string(body)
		m := umidRe.FindStringSubmatch(text)
		if m == nil {
			m = quotedRe.FindStringSubmatch(text)
		}
		if m != nil {
			token = m[1]
		} else {
			token = resp.Header.Get("Etag")
		}
	}()

	if token != "" && t2gAPrefix.MatchString(token) {
		c.mu.Lock()
		c.umid = token
		c.umidTime = time.Now()
		c.mu.Unlock()
		return token
	}
	return ""
}

// headers builds the request headers: Bearer + browser headers when logged
// in, Baxia WAF headers when in guest mode.
func (c *Client) headers(ctx context.Context, credential, cookies string) http.Header {
	h := http.Header{}
	if cred := strings.TrimSpace(credential); cred != "" {
		h.Set("Authorization", "Bearer "+cred)
		h.Set("x-request-id", newUUID())
		h.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
		h.Set("Accept", "application/json, text/plain, */*")
		h.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
		h.Set("Referer", "https://chat.qwen.ai/")
		h.Set("Origin", "https://chat.qwen.ai")
		h.Set("Connection", "keep-alive")
		h.Set("sec-ch-ua", `"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"`)
		h.Set("sec-ch-ua-mobile", "?0")
		h.Set("sec-ch-ua-platform", `"Windows"`)
		h.Set("sec-fetch-dest", "empty")
		h.Set("sec-fetch-mode", "cors")
		h.Set("sec-fetch-site", "same-origin")
		h.Set("Content-Type", "application/json")
		if strings.TrimSpace(cookies) != "" {
			h.Set("Cookie", strings.TrimSpace(cookies))
		}
		return h
	}
	h.Set("Accept", "application/json")
	h.Set("Content-Type", "application/json")
	h.Set("Origin", "https://chat.qwen.ai")
	h.Set("Referer", "https://chat.qwen.ai/c/guest")
	h.Set("source", "web")
	h.Set("version", "0.2.83")
	h.Set("x-request-id", newUUID())
	h.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	h.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")
	if umid := c.baxiaUmidToken(ctx); umid != "" {
		h.Set("bx-ua", baxiaUA())
		h.Set("bx-umidtoken", umid)
		h.Set("bx-v", BaxiaVersion)
	}
	if strings.TrimSpace(cookies) != "" {
		h.Set("Cookie", strings.TrimSpace(cookies))
	}
	return h
}

// do sends one authenticated request to the Qwen web API.
func (c *Client) do(ctx context.Context, credential, cookies, method, path string, body any) (*http.Response, error) {
	var rdr io.Reader
	if body != nil {
		j, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(j)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header = c.headers(ctx, credential, cookies)
	return c.HTTP.Do(req)
}

// textContent extracts plain text from an OpenAI message content value.
func textContent(content any) string {
	switch v := content.(type) {
	case nil:
		return ""
	case string:
		return v
	case []ContentPart:
		var parts []string
		for _, p := range v {
			if p.Text != "" {
				parts = append(parts, p.Text)
			}
		}
		return strings.Join(parts, "\n")
	case []any:
		var parts []string
		for _, p := range v {
			if m, ok := p.(map[string]any); ok {
				if t, ok := m["text"].(string); ok && t != "" {
					parts = append(parts, t)
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

// FlattenMessages flattens OpenAI messages into one prompt — disposable chats
// carry no history.
func FlattenMessages(messages []Message) string {
	var parts []string
	for _, m := range messages {
		text := strings.TrimSpace(textContent(m.Content))
		if text == "" {
			continue
		}
		if m.Role == "system" {
			parts = append(parts, text)
		} else if m.Role == "assistant" {
			parts = append(parts, "[Assistant]: "+text)
		} else {
			parts = append(parts, "[User]: "+text)
		}
	}
	return strings.Join(parts, "\n\n")
}

// riskControlError maps risk-control response text to a 429 QwenError.
// The response preview is included so the real cause is visible.
func riskControlError(text string) *QwenError {
	if riskRe.MatchString(text) {
		preview := strings.TrimSpace(text)
		preview = strings.Join(strings.Fields(preview), " ")
		if len(preview) > 250 {
			preview = preview[:250] + "…"
		}
		return NewQwenError(fmt.Sprintf("qwen risk control triggered — account parked in cooldown (qwen said: %s)", preview), 429)
	}
	return nil
}

type createChatResp struct {
	Data struct {
		ID string `json:"id"`
	} `json:"data"`
}

// createChat opens a disposable chat and returns its id.
func (c *Client) createChat(ctx context.Context, credential, cookies, model string) (string, error) {
	body := map[string]any{
		"title":      "New Chat",
		"models":     []string{model},
		"chat_mode":  chatMode(credential),
		"chat_type":  "t2t",
		"timestamp":  time.Now().UnixMilli(),
		"project_id": "",
	}
	resp, err := c.do(ctx, credential, cookies, http.MethodPost, "/api/v2/chats/new", body)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return "", NewQwenError("qwen token rejected — reconnect the account", 401)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		preview, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		status := resp.StatusCode
		if status >= 500 {
			status = 502
		}
		return "", NewQwenError(fmt.Sprintf("qwen create-chat failed (%d): %s", resp.StatusCode, preview), status)
	}
	var out createChatResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Data.ID == "" {
		return "", NewQwenError("qwen create-chat returned no chat id", 502)
	}
	return out.Data.ID, nil
}

// deleteChat removes the disposable chat; best-effort, never returns an error.
func (c *Client) deleteChat(ctx context.Context, credential, cookies, chatID string) {
	if chatID == "" {
		return
	}
	resp, err := c.do(ctx, credential, cookies, http.MethodDelete, "/api/v2/chats/"+chatID, nil)
	if err == nil && resp != nil {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
	}
}

// qwenDelta is one parsed SSE data payload.
type qwenDelta struct {
	kind string // "think" or "answer"
	text string
}

type deltaPayload struct {
	Choices []struct {
		Delta struct {
			Phase   string `json:"phase"`
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
}

// ParseQwenDelta parses one SSE `data:` payload into a think/answer delta.
// ok is false when the payload carries no usable content.
func ParseQwenDelta(payload string) (kind, text string, ok bool) {
	var obj deltaPayload
	if err := json.Unmarshal([]byte(payload), &obj); err != nil {
		return "", "", false
	}
	if len(obj.Choices) == 0 {
		return "", "", false
	}
	d := obj.Choices[0].Delta
	if d.Content == "" {
		return "", "", false
	}
	switch d.Phase {
	case "think", "thinking_summary":
		return "think", d.Content, true
	case "answer", "":
		return "answer", d.Content, true
	default:
		return "", "", false
	}
}

type openAIChunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index        int            `json:"index"`
		Delta        map[string]any `json:"delta"`
		FinishReason *string        `json:"finish_reason"`
	} `json:"choices"`
}

func sseChunk(id, model string, delta map[string]any, finish *string) string {
	c := openAIChunk{
		ID:      id,
		Object:  "chat.completion.chunk",
		Created: time.Now().Unix(),
		Model:   model,
		Choices: []struct {
			Index        int            `json:"index"`
			Delta        map[string]any `json:"delta"`
			FinishReason *string        `json:"finish_reason"`
		}{{Index: 0, Delta: delta, FinishReason: finish}},
	}
	j, _ := json.Marshal(c)
	return "data: " + string(j) + "\n\n"
}

// Validate checks a credential against the Qwen web API (lightweight chat list).
func (c *Client) Validate(ctx context.Context, credential, cookies string) error {
	resp, err := c.do(ctx, credential, cookies, http.MethodGet, "/api/v2/chats/?page=1&exclude_project=true", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return NewQwenError("token rejected (401/403) — sign in again and paste a fresh token", 401)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return NewQwenError(fmt.Sprintf("qwen web api returned %d", resp.StatusCode), resp.StatusCode)
	}
	return nil
}

// ChatCompletion runs one Qwen web chat turn and returns the body as an
// io.ReadCloser: OpenAI-format SSE when stream is true, or a single JSON
// chat.completion object otherwise. The caller must close the returned body.
func (c *Client) ChatCompletion(credential, cookies, model string, messages []Message, stream bool) (io.ReadCloser, error) {
	ctx := context.Background()
	prompt := FlattenMessages(messages)
	if prompt == "" {
		return nil, NewQwenError("empty prompt", 400)
	}
	chatID, err := c.createChat(ctx, credential, cookies, model)
	if err != nil {
		return nil, err
	}
	finished := false
	finishUp := func() {
		if !finished {
			finished = true
			c.deleteChat(context.Background(), credential, cookies, chatID)
		}
	}

	msgBody := map[string]any{
		"stream":             true,
		"version":            "2.1",
		"incremental_output": true,
		"chat_id":            chatID,
		"chat_mode":          chatMode(credential),
		"model":              model,
		"parent_id":          nil,
		"messages": []any{map[string]any{
			"fid":         newUUID(),
			"parentId":    nil,
			"childrenIds": []string{},
			"role":        "user",
			"content":     prompt,
			"user_action": "chat",
			"files":       []any{},
			"timestamp":   time.Now().Unix(),
			"models":      []string{model},
			"chat_type":   "t2t",
			"feature_config": map[string]any{
				"thinking_enabled": true,
				"output_schema":    "phase",
				"auto_thinking":    true,
				"research_mode":    "normal",
				"auto_search":      false,
			},
			"sub_chat_type": "t2t",
			"parent_id":     nil,
		}},
	}
	upstream, err := c.do(ctx, credential, cookies, http.MethodPost, "/api/v2/chat/completions?chat_id="+chatID, msgBody)
	if err != nil {
		finishUp()
		return nil, err
	}

	completionID := "chatcmpl-qwen-" + chatID
	if len(chatID) > 8 {
		completionID = "chatcmpl-qwen-" + chatID[:8]
	}

	// Risk control arrives as HTTP 200 JSON, not an event stream.
	if !strings.Contains(upstream.Header.Get("Content-Type"), "text/event-stream") {
		text, _ := io.ReadAll(io.LimitReader(upstream.Body, 1<<20))
		upstream.Body.Close()
		finishUp()
		if upstream.StatusCode == http.StatusUnauthorized || upstream.StatusCode == http.StatusForbidden {
			return nil, NewQwenError("qwen token rejected — reconnect the account", 401)
		}
		if rc := riskControlError(string(text)); rc != nil {
			return nil, rc
		}
		status := upstream.StatusCode
		if status >= 500 {
			status = 502
		}
		preview := text
		if len(preview) > 300 {
			preview = preview[:300]
		}
		return nil, NewQwenError(fmt.Sprintf("qwen completions failed (%d): %s", upstream.StatusCode, preview), status)
	}

	if !stream {
		rc, err := c.collectCompletion(upstream.Body, completionID, model)
		upstream.Body.Close()
		finishUp()
		if err != nil {
			return nil, err
		}
		return io.NopCloser(bytes.NewReader(rc)), nil
	}

	pr, pw := io.Pipe()
	go func() {
		defer upstream.Body.Close()
		defer finishUp()
		var werr error
		defer func() {
			if werr != nil {
				pw.CloseWithError(werr)
			} else {
				pw.Close()
			}
		}()
		write := func(s string) bool {
			if _, err := io.WriteString(pw, s); err != nil {
				werr = err
				return false
			}
			return true
		}
		scanner := bufio.NewScanner(upstream.Body)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
		sentRole := false
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "" || payload == "[DONE]" {
				continue
			}
			kind, text, ok := ParseQwenDelta(payload)
			if !ok {
				continue
			}
			if !sentRole {
				sentRole = true
				if !write(sseChunk(completionID, model, map[string]any{"role": "assistant", "content": ""}, nil)) {
					return
				}
			}
			var delta map[string]any
			if kind == "think" {
				delta = map[string]any{"reasoning_content": text}
			} else {
				delta = map[string]any{"content": text}
			}
			if !write(sseChunk(completionID, model, delta, nil)) {
				return
			}
		}
		if err := scanner.Err(); err != nil {
			werr = err
			return
		}
		stop := "stop"
		if !write(sseChunk(completionID, model, map[string]any{}, &stop)) {
			return
		}
		write("data: [DONE]\n\n")
	}()
	return pr, nil
}

// collectCompletion reads the full SSE turn and emits one JSON chat.completion.
func (c *Client) collectCompletion(body io.Reader, completionID, model string) ([]byte, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	var content, reasoning strings.Builder
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		kind, text, ok := ParseQwenDelta(payload)
		if !ok {
			continue
		}
		if kind == "think" {
			reasoning.WriteString(text)
		} else {
			content.WriteString(text)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if content.Len() == 0 && reasoning.Len() == 0 {
		return nil, NewQwenError("qwen returned an empty completion", 502)
	}
	message := map[string]any{"role": "assistant", "content": content.String()}
	if reasoning.Len() > 0 {
		message["reasoning_content"] = reasoning.String()
	}
	out := map[string]any{
		"id":      completionID,
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{
			"index":         0,
			"message":       message,
			"finish_reason": "stop",
		}},
		"usage": map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
	}
	return json.Marshal(out)
}
