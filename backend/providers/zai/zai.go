// Package zai implements the Z.ai web-chat protocol
// (chat.z.ai private web API, reverse-engineered).
//
// Protocol:
//  1. Auth: the user signs in at chat.z.ai in their own browser (solving the
//     Aliyun captcha manually once), then copies the JWT from DevTools ->
//     Application -> Local Storage -> "token". Validate with GET /api/v1/auths/.
//     The JWT payload carries {id, email}; the id signs every request.
//  2. Chat turn: POST /api/v2/chat/completions?<signed query>
//     Headers: Authorization: Bearer <token>, X-Signature, X-FE-Version.
//     The signature is an HMAC chain: bucket = floor(ts_ms / 300000),
//     w_key = HMAC_SHA256(salt_key, bucket),
//     sig = HMAC_SHA256(w_key, "{sorted k,v}|{prompt_b64}|{timestamp}").
//     salt_key falls back to a baked-in constant when the homepage scrape
//     misses; fe_version is scraped from the homepage the same way.
//     Response is SSE: data: {"data":{"delta_content":"..."}} ...
//     data: {"data":{"phase":"done"}} / [DONE].
//     Thinking streams wrapped in <details>...</details> tags — split into
//     reasoning_content, the rest is content.
//
// Caveat: private, undocumented endpoints — any upstream change can break this.
package zai

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Models is the Z.ai web model list.
var Models = []string{"glm-5.3-flash", "glm-5.3", "glm-5.2"}

// DefaultBaseURL is the Z.ai web frontend origin.
const DefaultBaseURL = "https://chat.z.ai"

// SaltKeyFallback is the baked-in fallback when the homepage scrape misses.
const SaltKeyFallback = "key-@@@@)))()((9))-xxxx&&&%%%%%"

// FEVersionFallback is the baked-in fallback when the homepage scrape misses.
const FEVersionFallback = "prod-fe-1.0.185"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// WebError is a Z.ai protocol error carrying an HTTP-style status.
type WebError struct {
	Msg    string
	Status int
}

func (e *WebError) Error() string { return e.Msg }

func webErrorf(status int, format string, args ...any) *WebError {
	return &WebError{Msg: fmt.Sprintf(format, args...), Status: status}
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

// Client is a Z.ai web API client. Credential is the JWT from
// chat.z.ai localStorage ("token").
type Client struct {
	BaseURL    string
	Credential string
	HTTP       *http.Client
	SaltKey    string
	FEVersion  string
}

// NewClient builds a Client. A nil httpClient gets a default with a 2-minute timeout.
func NewClient(baseURL, credential string, httpClient *http.Client) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 120 * time.Second}
	}
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		Credential: credential,
		HTTP:       httpClient,
		SaltKey:    SaltKeyFallback,
		FEVersion:  FEVersionFallback,
	}
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func baseHeaders() http.Header {
	return http.Header{
		"Content-Type": {"application/json"},
		"Origin":       {DefaultBaseURL},
		"Referer":      {DefaultBaseURL + "/"},
		"User-Agent":   {userAgent},
	}
}

func (c *Client) authHeaders() http.Header {
	h := baseHeaders()
	h.Set("Authorization", "Bearer "+strings.TrimSpace(c.Credential))
	return h
}

// Identity is the decoded JWT identity.
type Identity struct {
	ID    string
	Email string
}

// DecodeToken decodes the JWT payload (no signature verification — we just
// need id/email for request signing).
func DecodeToken(token string) *Identity {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var payload struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.ID == "" {
		return nil
	}
	return &Identity{ID: payload.ID, Email: payload.Email}
}

// ValidateCredential is a lightweight credential check: GET /api/v1/auths/.
// Returns the decoded identity on success.
func (c *Client) ValidateCredential(ctx context.Context) (*Identity, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/v1/auths/", nil)
	if err != nil {
		return nil, err
	}
	req.Header = c.authHeaders()
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, webErrorf(401, "token rejected — sign in at chat.z.ai again and paste a fresh token")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, webErrorf(resp.StatusCode, "token validation failed (%d)", resp.StatusCode)
	}
	id := DecodeToken(c.Credential)
	if id == nil {
		return nil, webErrorf(401, "token is not a valid Z.ai session token")
	}
	return id, nil
}

// ScrapeConfig scrapes salt_key / fe_version from the homepage; falls back to
// the baked-in constants on any failure.
func (c *Client) ScrapeConfig(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/", nil)
	if err != nil {
		return
	}
	req.Header = baseHeaders()
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	html, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return
	}
	// fe_version looks like prod-fe-1.0.185
	for i := 0; i+len("prod-fe-0.0.0") <= len(html); i++ {
		if html[i] == 'p' && strings.HasPrefix(string(html[i:]), "prod-fe-") {
			j := i + len("prod-fe-")
			k := j
			dots := 0
			for k < len(html) && (html[k] == '.' || (html[k] >= '0' && html[k] <= '9')) {
				if html[k] == '.' {
					dots++
				}
				k++
			}
			if dots >= 2 && k > j {
				c.FEVersion = string(html[i:k])
				return
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Request signing
// ---------------------------------------------------------------------------

func hmacSHA256Hex(key, data string) string {
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

// Signature is the signed query + signature header for one chat turn.
type Signature struct {
	Signature string
	Query     string
	Timestamp string
	RequestID string
}

// SignRequest builds the X-Signature header value and the signed query string
// for a chat turn. prompt is the last user message (signature_prompt).
func SignRequest(prompt, token, userID, saltKey string) Signature {
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	requestID := newUUID()
	ts, _ := strconv.ParseInt(timestamp, 10, 64)
	bucket := ts / 300000
	wKey := hmacSHA256Hex(saltKey, strconv.FormatInt(bucket, 10))

	payload := map[string]string{
		"timestamp": timestamp,
		"requestId": requestID,
		"user_id":   userID,
	}
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+","+payload[k])
	}
	sortedPayload := strings.Join(parts, ",")
	promptB64 := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(prompt)))
	dataToSign := sortedPayload + "|" + promptB64 + "|" + timestamp
	signature := hmacSHA256Hex(wKey, dataToSign)

	// Query params in web-client order (URLSearchParams insertion order).
	qp := [][2]string{
		{"timestamp", timestamp},
		{"requestId", requestID},
		{"user_id", userID},
		{"version", "0.0.1"},
		{"platform", "web"},
		{"token", token},
		{"user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		{"language", "en-US"},
		{"screen_resolution", "1920x1080"},
		{"viewport_size", "1920x1080"},
		{"timezone", "Europe/Paris"},
		{"timezone_offset", "-60"},
	}
	var qb strings.Builder
	for _, kv := range qp {
		if qb.Len() > 0 {
			qb.WriteByte('&')
		}
		qb.WriteString(url.QueryEscape(kv[0]))
		qb.WriteByte('=')
		qb.WriteString(url.QueryEscape(kv[1]))
	}
	qb.WriteString("&signature_timestamp=")
	qb.WriteString(url.QueryEscape(timestamp))

	return Signature{Signature: signature, Query: qb.String(), Timestamp: timestamp, RequestID: requestID}
}

// ---------------------------------------------------------------------------
// SSE parsing — thinking arrives wrapped in <details>...</details>.
// ---------------------------------------------------------------------------

// Delta is one think/answer fragment.
type Delta struct {
	Kind string // "think" or "answer"
	Text string
}

// SplitThinking splits accumulated Z.ai stream text into thinking vs answer.
// Thinking is wrapped in <details ...>...</details>; tags and "> " quote
// prefixes are stripped the way the web client renders them.
func SplitThinking(raw string) (thinking, answer string) {
	open := strings.Index(raw, "<details")
	if open < 0 {
		return "", raw
	}
	tagEnd := strings.Index(raw[open:], ">")
	if tagEnd < 0 {
		return "", raw
	}
	afterTag := raw[open+tagEnd+1:]
	closeIdx := strings.Index(afterTag, "</details>")
	strip := func(s string) string {
		// remove <details>/<summary> tags
		for {
			i := strings.Index(s, "<details")
			if i < 0 {
				break
			}
			j := strings.Index(s[i:], ">")
			if j < 0 {
				break
			}
			s = s[:i] + s[i+j+1:]
		}
		s = strings.ReplaceAll(s, "</details>", "")
		for {
			i := strings.Index(s, "<summary>")
			if i < 0 {
				break
			}
			j := strings.Index(s[i:], "</summary>")
			if j < 0 {
				break
			}
			s = s[:i] + s[i+j+len("</summary>"):]
		}
		lines := strings.Split(s, "\n")
		for i, l := range lines {
			lines[i] = strings.TrimPrefix(l, "> ")
		}
		return strings.TrimSpace(strings.Join(lines, "\n"))
	}
	if closeIdx < 0 {
		// Still streaming the thinking block.
		return strip(afterTag), raw[:open]
	}
	return strip(afterTag[:closeIdx]), raw[:open] + afterTag[closeIdx+len("</details>"):]
}

// Accumulator accumulates raw Z.ai stream text across SSE frames and emits
// only the new thinking/answer deltas. Required because a <details> thinking
// block usually spans several frames — splitting each frame in isolation
// misclassifies the tail (stray </details> tags leak into the answer).
type Accumulator struct {
	raw          string
	sentThinking string
	sentAnswer   string
}

// Push feeds raw delta text from one frame; returns the new deltas.
func (a *Accumulator) Push(text string) []Delta {
	a.raw += text
	thinking, answer := SplitThinking(a.raw)
	var deltas []Delta
	if strings.HasPrefix(thinking, a.sentThinking) {
		if len(thinking) > len(a.sentThinking) {
			deltas = append(deltas, Delta{Kind: "think", Text: thinking[len(a.sentThinking):]})
		}
		a.sentThinking = thinking
	} else {
		a.sentThinking = thinking
	}
	if strings.HasPrefix(answer, a.sentAnswer) {
		if len(answer) > len(a.sentAnswer) {
			deltas = append(deltas, Delta{Kind: "answer", Text: answer[len(a.sentAnswer):]})
		}
		a.sentAnswer = answer
	} else {
		a.sentAnswer = answer
	}
	return deltas
}

// Final returns the fully-split thinking and answer.
func (a *Accumulator) Final() (thinking, answer string) {
	return SplitThinking(a.raw)
}

// sseText extracts raw text from one SSE payload (no thinking split).
// Returns done=true when the turn finished.
func sseText(payload string) (text string, done bool) {
	var obj struct {
		Data *struct {
			Phase        string `json:"phase"`
			DeltaContent string `json:"delta_content"`
			EditContent  string `json:"edit_content"`
			Content      string `json:"content"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(payload), &obj); err != nil || obj.Data == nil {
		return "", false
	}
	if obj.Data.Phase == "done" {
		return "", true
	}
	switch {
	case obj.Data.DeltaContent != "":
		return obj.Data.DeltaContent, false
	case obj.Data.EditContent != "":
		return obj.Data.EditContent, false
	default:
		return obj.Data.Content, false
	}
}

// ---------------------------------------------------------------------------
// Chat turn
// ---------------------------------------------------------------------------

// ChatMessage is one flattened chat message.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// FlattenMessages flattens OpenAI messages, merging consecutive same-role ones.
func FlattenMessages(messages []struct {
	Role    string
	Content string
}) []ChatMessage {
	var out []ChatMessage
	for _, m := range messages {
		role := m.Role
		if role != "assistant" && role != "system" {
			role = "user"
		}
		content := strings.TrimSpace(m.Content)
		if content == "" {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content += "\n" + content
		} else {
			out = append(out, ChatMessage{Role: role, Content: content})
		}
	}
	return out
}

type chatBody struct {
	Model              string         `json:"model"`
	ChatID             string         `json:"chat_id"`
	Messages           []ChatMessage  `json:"messages"`
	SignaturePrompt    string         `json:"signature_prompt"`
	Stream             bool           `json:"stream"`
	CaptchaVerifyParam string         `json:"captcha_verify_param"`
	Features           map[string]any `json:"features"`
}

func (c *Client) buildBody(model string, messages []ChatMessage, prompt string, thinkingEnabled, searchEnabled bool) *chatBody {
	return &chatBody{
		Model:              model,
		ChatID:             newUUID(),
		Messages:           messages,
		SignaturePrompt:    prompt,
		Stream:             true,
		CaptchaVerifyParam: "",
		Features: map[string]any{
			"enable_thinking":  thinkingEnabled,
			"web_search":       false,
			"auto_web_search":  searchEnabled,
			"image_generation": false,
			"flags":            []any{},
		},
	}
}

// postChat sends one signed chat turn and returns the raw SSE response body.
// On 401 it re-validates the credential and retries once.
func (c *Client) postChat(ctx context.Context, model string, messages []ChatMessage, thinkingEnabled, searchEnabled bool) (io.ReadCloser, error) {
	for attempt := 0; attempt < 2; attempt++ {
		body, chatID, err := c.postChatOnce(ctx, model, messages, thinkingEnabled, searchEnabled)
		if err == nil {
			return &deletingBody{ReadCloser: body, client: c, chatID: chatID}, nil
		}
		if we, ok := err.(*WebError); ok && we.Status == 401 && attempt == 0 {
			// Token may have expired — re-validate and retry once.
			if _, verr := c.ValidateCredential(ctx); verr != nil {
				return nil, err
			}
			continue
		}
		return nil, err
	}
	return nil, webErrorf(401, "z.ai token rejected — reconnect the account")
}

// deletingBody deletes the Z.ai chat session when the response body closes.
type deletingBody struct {
	io.ReadCloser
	client *Client
	chatID string
	done   bool
}

func (d *deletingBody) Close() error {
	err := d.ReadCloser.Close()
	if !d.done {
		d.done = true
		d.client.deleteChat(context.Background(), d.chatID)
	}
	return err
}

// deleteChat removes a chat session from Z.ai (idempotent — "not found" counts as success).
func (c *Client) deleteChat(ctx context.Context, chatID string) {
	if chatID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.BaseURL+"/api/v1/chats/"+chatID, nil)
	if err != nil {
		return
	}
	req.Header = c.authHeaders()
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
	resp.Body.Close()
}

// isWAFBlock reports whether a response looks like the Aliyun WAF block page.
func isWAFBlock(status int, body []byte) bool {
	if status != 405 {
		return false
	}
	s := strings.ToLower(string(body))
	return strings.Contains(s, "aliyun") || strings.Contains(s, "waf") || strings.Contains(s, "block")
}

func (c *Client) postChatOnce(ctx context.Context, model string, messages []ChatMessage, thinkingEnabled, searchEnabled bool) (io.ReadCloser, string, error) {
	id := DecodeToken(c.Credential)
	if id == nil {
		return nil, "", webErrorf(401, "invalid Z.ai token")
	}
	var prompt string
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			prompt = messages[i].Content
			break
		}
	}
	sig := SignRequest(prompt, strings.TrimSpace(c.Credential), id.ID, c.SaltKey)
	chatBody := c.buildBody(model, messages, prompt, thinkingEnabled, searchEnabled)
	body, _ := json.Marshal(chatBody)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/v2/chat/completions?"+sig.Query, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	h := c.authHeaders()
	h.Set("X-Signature", sig.Signature)
	h.Set("X-Fe-Version", c.FEVersion)
	h.Set("X-Region", "overseas")
	req.Header = h
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, "", &WebError{Msg: err.Error(), Status: 502}
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		resp.Body.Close()
		return nil, "", webErrorf(401, "z.ai token rejected — reconnect the account")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if isWAFBlock(resp.StatusCode, b) {
			return nil, "", webErrorf(429, "z.ai WAF block — egress IP flagged, retry later")
		}
		suffix := ""
		if len(b) > 0 {
			s := string(b)
			if len(s) > 160 {
				s = s[:160]
			}
			suffix = ": " + s
		}
		return nil, "", webErrorf(resp.StatusCode, "z.ai chat failed (%d)%s", resp.StatusCode, suffix)
	}
	return resp.Body, chatBody.ChatID, nil
}

// ssePump reads SSE data lines from r, calling fn for each payload.
// fn returns true to stop early.
func ssePump(r io.Reader, fn func(payload string) bool) error {
	var buf strings.Builder
	tmp := make([]byte, 4096)
	flush := func() bool {
		for {
			s := buf.String()
			idx := strings.IndexByte(s, '\n')
			if idx < 0 {
				break
			}
			line := strings.TrimSpace(s[:idx])
			buf.Reset()
			buf.WriteString(s[idx+1:])
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "" || payload == "[DONE]" {
				continue
			}
			if fn(payload) {
				return true
			}
		}
		return false
	}
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			buf.Write(tmp[:n])
			if flush() {
				return nil
			}
		}
		if err != nil {
			if err == io.EOF {
				flush()
				return nil
			}
			return err
		}
	}
}

// Chat runs one chat turn and returns the full thinking + answer text.
func (c *Client) Chat(ctx context.Context, model string, messages []ChatMessage, thinkingEnabled, searchEnabled bool) (thinking, answer string, err error) {
	body, err := c.postChat(ctx, model, messages, thinkingEnabled, searchEnabled)
	if err != nil {
		return "", "", err
	}
	defer body.Close()
	acc := &Accumulator{}
	done := false
	err = ssePump(body, func(payload string) bool {
		text, finished := sseText(payload)
		acc.Push(text)
		if finished {
			done = true
			return true
		}
		return false
	})
	if err != nil {
		return "", "", err
	}
	_ = done
	thinking, answer = acc.Final()
	return thinking, answer, nil
}

// ListModels returns the live model list for /v1/models synthesis,
// falling back to the known models.
func (c *Client) ListModels(ctx context.Context) []string {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/models", nil)
	if err != nil {
		return Models
	}
	req.Header = c.authHeaders()
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Models
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Models
	}
	var j struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&j); err != nil {
		return Models
	}
	var ids []string
	for _, m := range j.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return Models
	}
	return ids
}

// ---------------------------------------------------------------------------
// OpenAI-format completion
// ---------------------------------------------------------------------------

// ChatOptions controls one OpenAI-format chat turn.
type ChatOptions struct {
	Model           string // resolved Z.ai model id
	ResponseModel   string // model name reported back to the client
	Stream          bool
	ThinkingEnabled bool
	SearchEnabled   bool
}

// ChatResult is the outcome of one chat turn.
type ChatResult struct {
	Content   string
	Reasoning string
	// Stream is non-nil when ChatOptions.Stream is true: OpenAI-format SSE.
	Stream io.ReadCloser
}

func openAIChunk(id, model string, delta map[string]any, finish *string) string {
	choice := map[string]any{"index": 0, "delta": delta, "finish_reason": nil}
	if finish != nil {
		choice["finish_reason"] = *finish
	}
	obj := map[string]any{
		"id":      id,
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{choice},
	}
	b, _ := json.Marshal(obj)
	return "data: " + string(b) + "\n\n"
}

// ChatCompletion runs one chat turn and returns OpenAI-format output:
// a single JSON chat.completion object when Stream=false, or an SSE stream
// of chat.completion.chunk objects when Stream=true.
func (c *Client) ChatCompletion(ctx context.Context, rawMessages []struct {
	Role    string
	Content string
}, opts ChatOptions) (*ChatResult, error) {
	messages := FlattenMessages(rawMessages)
	if len(messages) == 0 {
		return nil, webErrorf(400, "empty prompt")
	}
	outModel := opts.ResponseModel
	if outModel == "" {
		outModel = opts.Model
	}
	thinkingEnabled := opts.ThinkingEnabled // caller default; TS used !== false

	if !opts.Stream {
		thinking, answer, err := c.Chat(ctx, opts.Model, messages, thinkingEnabled, opts.SearchEnabled)
		if err != nil {
			return nil, err
		}
		msg := map[string]any{"role": "assistant", "content": answer}
		if thinking != "" {
			msg["reasoning_content"] = thinking
		}
		completion := map[string]any{
			"id":      fmt.Sprintf("zai-%d", time.Now().UnixMilli()),
			"object":  "chat.completion",
			"created": time.Now().Unix(),
			"model":   outModel,
			"choices": []any{map[string]any{
				"index": 0, "message": msg, "finish_reason": "stop",
			}},
			"usage": map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
		}
		b, _ := json.Marshal(completion)
		return &ChatResult{Content: answer, Reasoning: thinking, Stream: io.NopCloser(bytes.NewReader(b))}, nil
	}

	body, err := c.postChat(ctx, opts.Model, messages, thinkingEnabled, opts.SearchEnabled)
	if err != nil {
		return nil, err
	}
	pr, pw := io.Pipe()
	go func() {
		defer body.Close()
		id := fmt.Sprintf("zai-%d", time.Now().UnixMilli())
		sentRole := false
		send := func(s string) { _, _ = io.WriteString(pw, s) }
		sendRole := func() {
			if !sentRole {
				sentRole = true
				send(openAIChunk(id, outModel, map[string]any{"role": "assistant"}, nil))
			}
		}
		acc := &Accumulator{}
		pumpErr := ssePump(body, func(payload string) bool {
			text, finished := sseText(payload)
			for _, d := range acc.Push(text) {
				sendRole()
				if d.Kind == "think" {
					send(openAIChunk(id, outModel, map[string]any{"reasoning_content": d.Text}, nil))
				} else {
					send(openAIChunk(id, outModel, map[string]any{"content": d.Text}, nil))
				}
			}
			return finished
		})
		if pumpErr != nil {
			_ = pw.CloseWithError(pumpErr)
			return
		}
		stop := "stop"
		send(openAIChunk(id, outModel, map[string]any{}, &stop))
		send("data: [DONE]\n\n")
		_ = pw.Close()
	}()
	return &ChatResult{Stream: pr}, nil
}
