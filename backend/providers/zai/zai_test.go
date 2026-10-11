package zai

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

func makeTestToken(t *testing.T, id, email string) string {
	t.Helper()
	payload, _ := json.Marshal(map[string]string{"id": id, "email": email})
	enc := base64.RawURLEncoding.EncodeToString(payload)
	return "header." + enc + ".signature"
}

func TestDecodeToken(t *testing.T) {
	tok := makeTestToken(t, "user-123", "test@example.com")
	id := DecodeToken(tok)
	if id == nil {
		t.Fatal("DecodeToken returned nil")
	}
	if id.ID != "user-123" || id.Email != "test@example.com" {
		t.Fatalf("unexpected identity: %+v", id)
	}
}

func TestDecodeTokenInvalid(t *testing.T) {
	for _, tok := range []string{"", "abc", "a.b", "a.!!!.c"} {
		if DecodeToken(tok) != nil {
			t.Fatalf("expected nil for %q", tok)
		}
	}
	// Missing id.
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"a@b.c"}`))
	if DecodeToken("h."+payload+".s") != nil {
		t.Fatal("expected nil when id is missing")
	}
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

func TestSignRequestStructure(t *testing.T) {
	sig := SignRequest("hello world", "tok", "user-123", SaltKeyFallback)
	if len(sig.Signature) != 64 {
		t.Fatalf("signature length = %d, want 64 hex chars", len(sig.Signature))
	}
	if _, err := hex.DecodeString(sig.Signature); err != nil {
		t.Fatalf("signature is not hex: %v", err)
	}
	q, err := url.ParseQuery(sig.Query)
	if err != nil {
		t.Fatalf("query is not parseable: %v", err)
	}
	for _, k := range []string{"timestamp", "requestId", "user_id", "token", "signature_timestamp"} {
		if q.Get(k) == "" {
			t.Fatalf("query missing %q: %q", k, sig.Query)
		}
	}
	if q.Get("user_id") != "user-123" || q.Get("token") != "tok" {
		t.Fatalf("unexpected query values: %q", sig.Query)
	}
	if q.Get("timestamp") != q.Get("signature_timestamp") {
		t.Fatal("timestamp != signature_timestamp")
	}
	if q.Get("timestamp") != sig.Timestamp || q.Get("requestId") != sig.RequestID {
		t.Fatal("query params don't match returned timestamp/requestId")
	}
}

// TestSignRequestHMACChain recomputes the HMAC chain by hand and compares.
func TestSignRequestHMACChain(t *testing.T) {
	const prompt = "  hello world  "
	const userID = "user-123"
	sig := SignRequest(prompt, "tok", userID, SaltKeyFallback)

	mac := func(key, data string) string {
		h := hmac.New(sha256.New, []byte(key))
		h.Write([]byte(data))
		return hex.EncodeToString(h.Sum(nil))
	}
	ts, err := strconv.ParseInt(sig.Timestamp, 10, 64)
	if err != nil {
		t.Fatalf("bad timestamp: %v", err)
	}
	bucket := strconv.FormatInt(ts/300000, 10)
	wKey := mac(SaltKeyFallback, bucket)

	keys := []string{"requestId", "timestamp", "user_id"}
	payload := map[string]string{"timestamp": sig.Timestamp, "requestId": sig.RequestID, "user_id": userID}
	sort.Strings(keys)
	parts := make([]string, 0, 3)
	for _, k := range keys {
		parts = append(parts, k+","+payload[k])
	}
	promptB64 := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(prompt)))
	dataToSign := strings.Join(parts, ",") + "|" + promptB64 + "|" + sig.Timestamp
	want := mac(wKey, dataToSign)
	if sig.Signature != want {
		t.Fatalf("signature mismatch:\n got %s\nwant %s", sig.Signature, want)
	}
}

// ---------------------------------------------------------------------------
// Thinking split
// ---------------------------------------------------------------------------

func TestSplitThinkingNoDetails(t *testing.T) {
	thinking, answer := SplitThinking("just an answer")
	if thinking != "" || answer != "just an answer" {
		t.Fatalf("got thinking=%q answer=%q", thinking, answer)
	}
}

func TestSplitThinkingComplete(t *testing.T) {
	raw := `<details type="thinking" open><summary>Thinking</summary>` + "\n> deep thought\n> more\n</details>" + "hello world"
	thinking, answer := SplitThinking(raw)
	if thinking != "deep thought\nmore" {
		t.Fatalf("thinking = %q", thinking)
	}
	if answer != "hello world" {
		t.Fatalf("answer = %q", answer)
	}
}

func TestSplitThinkingStreaming(t *testing.T) {
	// Unclosed <details> — still streaming the thinking block.
	raw := `prefix<details><summary>Thinking</summary>` + "\n> partial"
	thinking, answer := SplitThinking(raw)
	if thinking != "partial" {
		t.Fatalf("thinking = %q", thinking)
	}
	if answer != "prefix" {
		t.Fatalf("answer = %q", answer)
	}
}

func TestAccumulatorMultiFrame(t *testing.T) {
	acc := &Accumulator{}
	var got []Delta
	// Frame 1: thinking block opens (unclosed).
	got = append(got, acc.Push(`<details><summary>Thinking</summary>`+"\n> deep")...)
	// Frame 2: thinking continues.
	got = append(got, acc.Push(" thought\n")...)
	// Frame 3: thinking closes, answer starts.
	got = append(got, acc.Push("</details>hello")...)
	// Frame 4: answer continues.
	got = append(got, acc.Push(" world")...)

	var thinking, answer strings.Builder
	for _, d := range got {
		switch d.Kind {
		case "think":
			thinking.WriteString(d.Text)
		case "answer":
			answer.WriteString(d.Text)
		}
	}
	if thinking.String() != "deep thought" {
		t.Fatalf("thinking = %q", thinking.String())
	}
	if answer.String() != "hello world" {
		t.Fatalf("answer = %q", answer.String())
	}
	// No stray tags leaked into the answer.
	for _, d := range got {
		if strings.Contains(d.Text, "<details") || strings.Contains(d.Text, "</details>") {
			t.Fatalf("tag leaked into delta: %q", d.Text)
		}
	}
}

func TestAccumulatorFinal(t *testing.T) {
	acc := &Accumulator{}
	acc.Push("<details><summary>T</summary>\n> a\n</details>b")
	thinking, answer := acc.Final()
	if thinking != "a" || answer != "b" {
		t.Fatalf("got thinking=%q answer=%q", thinking, answer)
	}
}

// ---------------------------------------------------------------------------
// HTTP lifecycle (httptest mock)
// ---------------------------------------------------------------------------

func mockZai(t *testing.T, sse string, onChat func(r *http.Request, body []byte)) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/auths/", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	mux.HandleFunc("/api/v2/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		reqBody, _ := io.ReadAll(r.Body)
		if onChat != nil {
			onChat(r, reqBody)
		}
		if r.Header.Get("X-Signature") == "" {
			http.Error(w, "missing signature", http.StatusBadRequest)
			return
		}
		if r.Header.Get("X-Fe-Version") == "" {
			http.Error(w, "missing fe version", http.StatusBadRequest)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			Model           string `json:"model"`
			SignaturePrompt string `json:"signature_prompt"`
			Stream          bool   `json:"stream"`
		}
		_ = json.Unmarshal(reqBody, &body)
		if body.Model == "" || !body.Stream {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, sse)
	})
	mux.HandleFunc("/api/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"glm-5.3-flash"},{"id":"glm-5.3"}]}`)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, `<html><script src="/prod-fe-1.0.190/app.js"></script></html>`)
	})
	return httptest.NewServer(mux)
}

func TestValidateCredential(t *testing.T) {
	srv := mockZai(t, "", nil)
	defer srv.Close()
	c := NewClient(srv.URL, makeTestToken(t, "user-123", "test@example.com"), srv.Client())
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	id, err := c.ValidateCredential(context.Background())
	if err != nil {
		t.Fatalf("ValidateCredential: %v", err)
	}
	if id.ID != "user-123" {
		t.Fatalf("unexpected identity: %+v", id)
	}
}

func TestValidateCredentialRejected(t *testing.T) {
	srv := mockZai(t, "", nil)
	defer srv.Close()
	c := NewClient(srv.URL, "not-a-jwt", srv.Client())
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	_, err := c.ValidateCredential(context.Background())
	// The mock returns 401 for missing Bearer prefix... "not-a-jwt" IS sent as
	// Bearer, so the mock returns 200 but DecodeToken fails -> 401 WebError.
	we, ok := err.(*WebError)
	if !ok || we.Status != 401 {
		t.Fatalf("expected 401 WebError, got %v", err)
	}
}

func TestScrapeConfig(t *testing.T) {
	srv := mockZai(t, "", nil)
	defer srv.Close()
	c := NewClient(srv.URL, "tok", srv.Client())
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	c.ScrapeConfig(context.Background())
	if c.FEVersion != "prod-fe-1.0.190" {
		t.Fatalf("fe version = %q", c.FEVersion)
	}
}

func TestListModels(t *testing.T) {
	srv := mockZai(t, "", nil)
	defer srv.Close()
	c := NewClient(srv.URL, makeTestToken(t, "u", "e@x.y"), srv.Client())
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	models := c.ListModels(context.Background())
	if len(models) != 2 || models[0] != "glm-5.3-flash" {
		t.Fatalf("models = %v", models)
	}
}

const zaiTestSSE = "data: {\"data\":{\"delta_content\":\"<details><summary>Thinking</summary>\\n> deep thought\\n</details>\"}}\n\n" +
	"data: {\"data\":{\"delta_content\":\"hello\"}}\n\n" +
	"data: {\"data\":{\"delta_content\":\" world\"}}\n\n" +
	"data: {\"data\":{\"phase\":\"done\"}}\n\n"

func TestChatNonStream(t *testing.T) {
	var gotSig, gotFE, gotModel, gotPrompt string
	var gotThinking bool
	srv := mockZai(t, zaiTestSSE, func(r *http.Request, reqBody []byte) {
		gotSig = r.Header.Get("X-Signature")
		gotFE = r.Header.Get("X-Fe-Version")
		var body struct {
			Model           string         `json:"model"`
			SignaturePrompt string         `json:"signature_prompt"`
			Features        map[string]any `json:"features"`
		}
		_ = json.Unmarshal(reqBody, &body)
		gotModel = body.Model
		gotPrompt = body.SignaturePrompt
		if v, ok := body.Features["enable_thinking"].(bool); ok {
			gotThinking = v
		}
		q := r.URL.Query()
		if q.Get("user_id") != "user-123" {
			t.Errorf("query user_id = %q", q.Get("user_id"))
		}
	})
	defer srv.Close()
	c := NewClient(srv.URL, makeTestToken(t, "user-123", "test@example.com"), srv.Client())
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	thinking, answer, err := c.Chat(ctx, "glm-5.3-flash",
		[]ChatMessage{{Role: "user", Content: "hi"}}, true, false)
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if thinking != "deep thought" {
		t.Fatalf("thinking = %q", thinking)
	}
	if answer != "hello world" {
		t.Fatalf("answer = %q", answer)
	}
	if gotSig == "" || gotFE == "" {
		t.Fatal("missing signature headers")
	}
	if gotModel != "glm-5.3-flash" || gotPrompt != "hi" || !gotThinking {
		t.Fatalf("unexpected body: model=%q prompt=%q thinking=%v", gotModel, gotPrompt, gotThinking)
	}
}

func TestChatCompletionNonStream(t *testing.T) {
	srv := mockZai(t, zaiTestSSE, nil)
	defer srv.Close()
	c := NewClient(srv.URL, makeTestToken(t, "user-123", "test@example.com"), srv.Client())
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := c.ChatCompletion(ctx, []struct {
		Role    string
		Content string
	}{{Role: "user", Content: "hi"}}, ChatOptions{Model: "glm-5.3-flash", ResponseModel: "glm-5.3-flash"})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	if res.Content != "hello world" || res.Reasoning != "deep thought" {
		t.Fatalf("got content=%q reasoning=%q", res.Content, res.Reasoning)
	}
	// The non-stream ChatResult.Stream carries the JSON completion object.
	data, err := io.ReadAll(res.Stream)
	_ = res.Stream.Close()
	if err != nil {
		t.Fatalf("reading result: %v", err)
	}
	var completion struct {
		Object  string `json:"object"`
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &completion); err != nil {
		t.Fatalf("result is not a JSON completion: %v", err)
	}
	if completion.Object != "chat.completion" {
		t.Fatalf("object = %q", completion.Object)
	}
	if completion.Choices[0].Message.ReasoningContent != "deep thought" {
		t.Fatalf("reasoning_content = %q", completion.Choices[0].Message.ReasoningContent)
	}
}

func TestChatCompletionStream(t *testing.T) {
	srv := mockZai(t, zaiTestSSE, nil)
	defer srv.Close()
	c := NewClient(srv.URL, makeTestToken(t, "user-123", "test@example.com"), srv.Client())
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := c.ChatCompletion(ctx, []struct {
		Role    string
		Content string
	}{{Role: "user", Content: "hi"}}, ChatOptions{Model: "glm-5.3-flash", Stream: true})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	if res.Stream == nil {
		t.Fatal("expected non-nil Stream")
	}
	data, err := io.ReadAll(res.Stream)
	_ = res.Stream.Close()
	if err != nil {
		t.Fatalf("reading stream: %v", err)
	}
	s := string(data)
	for _, want := range []string{
		`"reasoning_content":"deep thought"`,
		`"content":"hello"`,
		`"content":" world"`,
		`"finish_reason":"stop"`,
		"data: [DONE]",
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("stream missing %q:\n%s", want, s)
		}
	}
}

func TestChatCompletionEmpty(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", makeTestToken(t, "u", "e@x.y"), nil)
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	_, err := c.ChatCompletion(context.Background(), []struct {
		Role    string
		Content string
	}{{Role: "user", Content: "  "}}, ChatOptions{Model: "glm-5.3-flash"})
	if we, ok := err.(*WebError); !ok || we.Status != 400 {
		t.Fatalf("expected 400 WebError, got %v", err)
	}
}

func TestFlattenMessages(t *testing.T) {
	got := FlattenMessages([]struct {
		Role    string
		Content string
	}{
		{Role: "user", Content: "hi"},
		{Role: "user", Content: "again"},
		{Role: "assistant", Content: "hello"},
		{Role: "system", Content: "  "},
	})
	if len(got) != 2 {
		t.Fatalf("got %d messages: %+v", len(got), got)
	}
	if got[0].Content != "hi\nagain" || got[1].Role != "assistant" {
		t.Fatalf("unexpected flatten: %+v", got)
	}
}

func TestGLMFreeAPIMethod(t *testing.T) {
	// Verifies the request matches the GLM-Free-API method exactly:
	// headers (x-region: overseas), body shape, 401 retry, chat deletion.
	var (
		mu            sync.Mutex
		gotRegion     string
		gotSig        string
		gotBody       map[string]any
		deleteCalls   []string
		completions   int
		validateCalls int
	)
	// Build a fake JWT: {"id":"user123","email":"test@example.com"}
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"id":"user123","email":"test@example.com"}`))
	token := "header." + payload + ".sig"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.URL.Path == "/api/v1/auths/":
			validateCalls++
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{"token":"` + token + `"}`))
		case strings.HasPrefix(r.URL.Path, "/api/v2/chat/completions"):
			completions++
			if completions == 1 {
				// First attempt: 401 to trigger re-validate + retry.
				w.WriteHeader(401)
				return
			}
			gotRegion = r.Header.Get("X-Region")
			gotSig = r.Header.Get("X-Signature")
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &gotBody)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"data\":{\"delta_content\":\"hi\"}}\n\ndata: {\"data\":{\"phase\":\"done\"}}\n\n"))
		case strings.HasPrefix(r.URL.Path, "/api/v1/chats/"):
			deleteCalls = append(deleteCalls, r.URL.Path)
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, token, srv.Client())
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	ctx := context.Background()
	thinking, answer, err := c.Chat(ctx, "glm-5.3-flash",
		[]ChatMessage{{Role: "user", Content: "hello"}}, true, false)
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if answer != "hi" {
		t.Fatalf("answer = %q", answer)
	}
	if thinking != "" {
		t.Fatalf("thinking = %q", thinking)
	}

	mu.Lock()
	defer mu.Unlock()
	if gotRegion != "overseas" {
		t.Fatalf("X-Region = %q, want overseas", gotRegion)
	}
	if gotSig == "" {
		t.Fatal("X-Signature missing")
	}
	// Body shape per GLM-Free-API.
	for _, k := range []string{"model", "chat_id", "messages", "signature_prompt", "stream", "captcha_verify_param", "features"} {
		if _, ok := gotBody[k]; !ok {
			t.Fatalf("body missing %q: %v", k, gotBody)
		}
	}
	for _, k := range []string{"params", "extra", "variables", "background_tasks"} {
		if _, ok := gotBody[k]; ok {
			t.Fatalf("body should not contain %q", k)
		}
	}
	feats, _ := gotBody["features"].(map[string]any)
	if feats["web_search"] != false {
		t.Fatalf("web_search should be false, got %v", feats["web_search"])
	}
	if feats["image_generation"] != false {
		t.Fatalf("image_generation should be false, got %v", feats["image_generation"])
	}
	if feats["auto_web_search"] != false {
		t.Fatalf("auto_web_search should be false when search disabled, got %v", feats["auto_web_search"])
	}
	// 401 retry: 2 completion attempts + 1 re-validation.
	if completions != 2 {
		t.Fatalf("completions = %d, want 2 (401 retry)", completions)
	}
	if validateCalls != 1 {
		t.Fatalf("validateCalls = %d, want 1", validateCalls)
	}
	// Chat deletion after completion.
	if len(deleteCalls) != 1 {
		t.Fatalf("deleteCalls = %v, want 1", deleteCalls)
	}
	if !strings.HasPrefix(deleteCalls[0], "/api/v1/chats/") {
		t.Fatalf("delete path = %q", deleteCalls[0])
	}
}

func TestCaptchaParamSent(t *testing.T) {
	// The captcha_verify_param must carry the generated value, not empty.
	var gotParam string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v2/chat/completions") {
			b, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(b, &body)
			gotParam, _ = body["captcha_verify_param"].(string)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"data\":{\"phase\":\"done\"}}\n\n"))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/chats/") {
			w.WriteHeader(200)
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, makeTestToken(t, "u", "e@x.y"), srv.Client())
	c.DeviceToken = "test-device-token"
	captchaComputeOverride = "test-captcha-param"
	defer func() { captchaComputeOverride = "" }()
	c.DeviceToken = "dev-token"
	captchaComputeOverride = "generated-param-123"
	defer func() { captchaComputeOverride = "" }()

	_, _, err := c.Chat(context.Background(), "glm-5.3-flash",
		[]ChatMessage{{Role: "user", Content: "hi"}}, true, false)
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if gotParam != "generated-param-123" {
		t.Fatalf("captcha_verify_param = %q, want generated value", gotParam)
	}
}

func TestCaptchaMissingDeviceToken(t *testing.T) {
	// No device token → clear 429-style error, no request sent.
	c := NewClient("http://127.0.0.1:1", makeTestToken(t, "u", "e@x.y"), nil)
	// No device token and no override → must fail before any request.
	_, _, err := c.Chat(context.Background(), "glm-5.3-flash",
		[]ChatMessage{{Role: "user", Content: "hi"}}, true, false)
	if err == nil {
		t.Fatal("expected error without device token")
	}
	we, ok := err.(*WebError)
	if !ok || we.Status != 429 {
		t.Fatalf("err = %v, want WebError 429", err)
	}
}

func TestCaptchaCryptoDeterministic(t *testing.T) {
	// Pure functions must be deterministic.
	a1, a2 := generateArg("test-certify-id"), generateArg("test-certify-id")
	if a1 != a2 || a1 == "" {
		t.Fatal("generateArg not deterministic")
	}
	h1, h2 := aliHash("hello", "0000"), aliHash("hello", "0000")
	if h1 != h2 || len(h1) != 32 {
		t.Fatalf("aliHash = %q", h1)
	}
	e1, e2 := captchaEncrypt([]byte("data")), captchaEncrypt([]byte("data"))
	if e1 != e2 || e1 == "" {
		t.Fatal("captchaEncrypt not deterministic")
	}
}
