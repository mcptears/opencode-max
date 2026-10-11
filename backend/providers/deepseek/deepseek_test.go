package deepseek

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// DeepSeekHashV1 / PoW
// ---------------------------------------------------------------------------

func TestDeepSeekHashV1Deterministic(t *testing.T) {
	a := DeepSeekHashV1([]byte("testsalt_1234567890_42"))
	b := DeepSeekHashV1([]byte("testsalt_1234567890_42"))
	if a != b {
		t.Fatal("hash is not deterministic")
	}
	c := DeepSeekHashV1([]byte("testsalt_1234567890_43"))
	if a == c {
		t.Fatal("different inputs produced the same digest")
	}
	if len(a) != 32 {
		t.Fatalf("digest length = %d, want 32", len(a))
	}
}

func TestDeepSeekHashV1MultiBlock(t *testing.T) {
	// >136 bytes exercises the multi-block path.
	msg := []byte(strings.Repeat("abcdefgh", 32)) // 256 bytes
	d := DeepSeekHashV1(msg)
	if d == DeepSeekHashV1([]byte(strings.Repeat("abcdefgh", 31))) {
		t.Fatal("multi-block hash collides with shorter input")
	}
	var zero [32]byte
	if d == zero {
		t.Fatal("digest is all zeros")
	}
}

// TestSolvePoWRoundTrip builds a synthetic challenge from a known nonce and
// verifies the solver recovers it.
func TestSolvePoWRoundTrip(t *testing.T) {
	const salt = "testsalt"
	const expireAt = int64(1791700000)
	const nonce = int64(42)
	digest := DeepSeekHashV1([]byte(salt + "_" + strconv.FormatInt(expireAt, 10) + "_" + strconv.FormatInt(nonce, 10)))
	ch := Challenge{
		Algorithm:  "DeepSeekHashV1",
		Challenge:  hex.EncodeToString(digest[:]),
		Salt:       salt,
		Difficulty: 1000,
		ExpireAt:   expireAt,
		Signature:  "sig",
		TargetPath: "/api/v0/chat/completion",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	got, err := SolvePoW(ctx, ch)
	if err != nil {
		t.Fatalf("SolvePoW: %v", err)
	}
	if got != nonce {
		t.Fatalf("SolvePoW = %d, want %d", got, nonce)
	}
}

func TestSolvePoWRejectsBadAlgorithm(t *testing.T) {
	_, err := SolvePoW(context.Background(), Challenge{Algorithm: "SHA256", Difficulty: 10})
	if err == nil {
		t.Fatal("expected error for unsupported algorithm")
	}
}

func TestSolvePoWContextCancel(t *testing.T) {
	// Impossible challenge (difficulty 1, wrong digest) with a cancelled ctx.
	ch := Challenge{
		Algorithm:  "DeepSeekHashV1",
		Challenge:  strings.Repeat("ab", 32),
		Salt:       "s",
		Difficulty: 1 << 40,
		ExpireAt:   1,
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// Force at least one 4096-boundary check by pre-cancelling; the solver
	// checks ctx every 4096 nonces.
	_, err := SolvePoW(ctx, ch)
	if err == nil {
		t.Fatal("expected context error")
	}
}

func TestPoWResponseHeader(t *testing.T) {
	ch := Challenge{Algorithm: "DeepSeekHashV1", Challenge: "abc", Salt: "s", Signature: "sig", TargetPath: "/api/v0/chat/completion"}
	hdr := PoWResponseHeader(ch, 42)
	var decoded struct {
		Algorithm string `json:"algorithm"`
		Answer    int64  `json:"answer"`
	}
	raw, err := base64.StdEncoding.DecodeString(hdr)
	if err != nil {
		t.Fatalf("header is not base64: %v", err)
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("header payload is not JSON: %v", err)
	}
	if decoded.Algorithm != "DeepSeekHashV1" || decoded.Answer != 42 {
		t.Fatalf("unexpected header payload: %+v", decoded)
	}
}

func TestGenerateDeviceID(t *testing.T) {
	id := GenerateDeviceID()
	if len(id) != 88 {
		t.Fatalf("device id length = %d, want 88", len(id))
	}
	if id[0] != 'B' || !strings.HasSuffix(id, "==") {
		t.Fatalf("device id has wrong shape: %q", id)
	}
	if GenerateDeviceID() == id {
		t.Fatal("device ids are not random")
	}
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

func TestParseDeltaInitialEnvelope(t *testing.T) {
	st := &DeltaState{}
	deltas := ParseDelta(`{"v":{"response":{"fragments":[{"type":"THINK","content":"let me think"}]}}}`, st)
	if len(deltas) != 1 || deltas[0].Kind != "think" || deltas[0].Text != "let me think" {
		t.Fatalf("unexpected deltas: %+v", deltas)
	}
	if st.FragmentType != "THINK" {
		t.Fatalf("fragment type = %q, want THINK", st.FragmentType)
	}
	// Continuation APPENDs follow the announced type.
	deltas = ParseDelta(`{"p":"response/fragments/-1/content","o":"APPEND","v":" more"}`, st)
	if len(deltas) != 1 || deltas[0].Kind != "think" || deltas[0].Text != " more" {
		t.Fatalf("unexpected continuation: %+v", deltas)
	}
}

func TestParseDeltaAnswerFragment(t *testing.T) {
	st := &DeltaState{}
	deltas := ParseDelta(`{"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"hello"}]}`, st)
	if len(deltas) != 1 || deltas[0].Kind != "answer" || deltas[0].Text != "hello" {
		t.Fatalf("unexpected deltas: %+v", deltas)
	}
}

func TestParseDeltaBareContinuation(t *testing.T) {
	st := &DeltaState{FragmentType: "RESPONSE"}
	deltas := ParseDelta(`{"v":" world"}`, st)
	if len(deltas) != 1 || deltas[0].Kind != "answer" || deltas[0].Text != " world" {
		t.Fatalf("unexpected deltas: %+v", deltas)
	}
}

func TestParseDeltaUsageAndDone(t *testing.T) {
	st := &DeltaState{}
	deltas := ParseDelta(`{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":65}]}`, st)
	if len(deltas) != 1 || !deltas[0].HasUsage || deltas[0].Usage != 65 {
		t.Fatalf("unexpected usage delta: %+v", deltas)
	}
	deltas = ParseDelta(`{"p":"response/status","o":"SET","v":"FINISHED"}`, st)
	if len(deltas) != 1 || !deltas[0].Done {
		t.Fatalf("unexpected done delta: %+v", deltas)
	}
}

func TestParseDeltaInvalidJSON(t *testing.T) {
	if deltas := ParseDelta(`not json`, &DeltaState{}); len(deltas) != 0 {
		t.Fatalf("expected no deltas, got %+v", deltas)
	}
}

func TestFlattenMessages(t *testing.T) {
	got := FlattenMessages([]Message{
		{Role: "system", Content: "be nice"},
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: "hello"},
		{Role: "user", Content: "  "},
	})
	want := "be nice\n\n[User]: hi\n\n[Assistant]: hello"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestResolveModel(t *testing.T) {
	r := ResolveModel("deepseek-chat", false, false)
	if r.ModelType != "default" || r.ThinkingEnabled || r.SearchEnabled {
		t.Fatalf("unexpected: %+v", r)
	}
	r = ResolveModel("deepseek-chat", true, false)
	if r.ModelType != "thinking" || !r.ThinkingEnabled {
		t.Fatalf("thinking default not applied: %+v", r)
	}
	r = ResolveModel("deepseek-reasoner", false, false)
	if r.ModelType != "thinking" {
		t.Fatalf("reasoner marker not detected: %+v", r)
	}
	r = ResolveModel("deepseek-chat-search", false, false)
	if !r.SearchEnabled {
		t.Fatalf("search marker not detected: %+v", r)
	}
}

// ---------------------------------------------------------------------------
// HTTP lifecycle (httptest mock)
// ---------------------------------------------------------------------------

func writeBiz(w http.ResponseWriter, bizData any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"code": 0,
		"data": map[string]any{"code": 0, "biz_msg": "", "biz_data": bizData},
	})
}

// mockDeepSeek returns a server speaking the DeepSeek web API plus a hook to
// observe the completion request headers.
func mockDeepSeek(t *testing.T, sse string, onCompletion func(r *http.Request)) *httptest.Server {
	t.Helper()
	// Precompute a solvable PoW challenge.
	const salt = "testsalt"
	const expireAt = int64(1791700000)
	const nonce = int64(7)
	digest := DeepSeekHashV1([]byte(salt + "_" + strconv.FormatInt(expireAt, 10) + "_" + strconv.FormatInt(nonce, 10)))
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v0/chat_session/create", func(w http.ResponseWriter, r *http.Request) {
		writeBiz(w, map[string]any{"chat_session": map[string]any{"id": "sess-123"}})
	})
	mux.HandleFunc("/api/v0/chat/create_pow_challenge", func(w http.ResponseWriter, r *http.Request) {
		writeBiz(w, map[string]any{"challenge": map[string]any{
			"algorithm": "DeepSeekHashV1", "challenge": hex.EncodeToString(digest[:]),
			"salt": salt, "difficulty": 1000, "expire_at": expireAt,
			"signature": "sig", "target_path": "/api/v0/chat/completion",
		}})
	})
	mux.HandleFunc("/api/v0/chat/completion", func(w http.ResponseWriter, r *http.Request) {
		if onCompletion != nil {
			onCompletion(r)
		}
		if r.Header.Get("X-Ds-Pow-Response") == "" {
			http.Error(w, "missing pow", http.StatusBadRequest)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			http.Error(w, "missing auth", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, sse)
	})
	mux.HandleFunc("/api/v0/chat_session/delete", func(w http.ResponseWriter, r *http.Request) {
		writeBiz(w, map[string]any{})
	})
	mux.HandleFunc("/api/v0/users/login", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["verification_code"] != "" {
			writeBiz(w, map[string]any{"user": map[string]any{"token": "tok-after-code"}})
			return
		}
		if body["email"] == "needcode@example.com" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": map[string]any{"code": 0, "biz_msg": "Please check your email for the verification code", "biz_data": map[string]any{}},
			})
			return
		}
		writeBiz(w, map[string]any{"user": map[string]any{"token": "tok-abc"}})
	})
	return httptest.NewServer(mux)
}

const testSSE = "data: {\"v\":{\"response\":{\"fragments\":[{\"type\":\"THINK\",\"content\":\"let me think\"}]}}}\n\n" +
	"data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\" more\"}\n\n" +
	"data: {\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{\"type\":\"RESPONSE\",\"content\":\"hello\"}]}\n\n" +
	"data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\" world\"}\n\n" +
	"data: {\"p\":\"response\",\"o\":\"BATCH\",\"v\":[{\"p\":\"accumulated_token_usage\",\"v\":65}]}\n\n" +
	"data: {\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}\n\n"

func TestSignInOK(t *testing.T) {
	srv := mockDeepSeek(t, testSSE, nil)
	defer srv.Close()
	res, err := SignIn(context.Background(), srv.Client(), srv.URL, "a@b.c", "hash", "")
	if err != nil {
		t.Fatalf("SignIn: %v", err)
	}
	if !res.OK || res.Credential != "tok-abc" {
		t.Fatalf("unexpected result: %+v", res)
	}
}

func TestSignInVerificationChallenge(t *testing.T) {
	srv := mockDeepSeek(t, testSSE, nil)
	defer srv.Close()
	res, err := SignIn(context.Background(), srv.Client(), srv.URL, "needcode@example.com", "hash", "")
	if err != nil {
		t.Fatalf("SignIn: %v", err)
	}
	if res.OK || !res.NeedCode {
		t.Fatalf("expected NeedCode, got %+v", res)
	}
	// Retry with the code.
	res, err = SignIn(context.Background(), srv.Client(), srv.URL, "needcode@example.com", "hash", "123456")
	if err != nil {
		t.Fatalf("SignIn with code: %v", err)
	}
	if !res.OK || res.Credential != "tok-after-code" {
		t.Fatalf("unexpected result: %+v", res)
	}
}

func TestValidateCredential(t *testing.T) {
	srv := mockDeepSeek(t, testSSE, nil)
	defer srv.Close()
	c := NewClient(srv.URL, "tok-abc", "cookies=1", srv.Client())
	if err := c.ValidateCredential(context.Background()); err != nil {
		t.Fatalf("ValidateCredential: %v", err)
	}
}

func TestValidateCredentialDeadToken(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v0/chat_session/create", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"code":40003,"data":{}}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := NewClient(srv.URL, "dead", "", srv.Client())
	err := c.ValidateCredential(context.Background())
	we, ok := err.(*WebError)
	if !ok || we.Status != 401 {
		t.Fatalf("expected 401 WebError, got %v", err)
	}
}

func TestChatCompletionNonStream(t *testing.T) {
	var gotPowHeader, gotAuth, gotCookie string
	var gotBody struct {
		ModelType string `json:"model_type"`
		Prompt    string `json:"prompt"`
	}
	srv := mockDeepSeek(t, testSSE, func(r *http.Request) {
		gotPowHeader = r.Header.Get("X-Ds-Pow-Response")
		gotAuth = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
	})
	defer srv.Close()
	c := NewClient(srv.URL, "tok-abc", "sess=xyz", srv.Client())
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	res, err := c.ChatCompletion(ctx, []Message{{Role: "user", Content: "hi"}}, ChatOptions{
		Model: "deepseek-chat", ResponseModel: "deepseek-chat",
	})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	if res.Stream != nil {
		t.Fatal("expected nil Stream for non-streaming call")
	}
	if res.Content != "hello world" {
		t.Fatalf("content = %q, want %q", res.Content, "hello world")
	}
	if res.Reasoning != "let me think more" {
		t.Fatalf("reasoning = %q, want %q", res.Reasoning, "let me think more")
	}
	if res.Usage != 65 {
		t.Fatalf("usage = %d, want 65", res.Usage)
	}
	if gotAuth != "Bearer tok-abc" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	if gotCookie != "sess=xyz" {
		t.Fatalf("cookie header = %q", gotCookie)
	}
	if gotBody.ModelType != "default" || !strings.Contains(gotBody.Prompt, "hi") {
		t.Fatalf("unexpected completion body: %+v", gotBody)
	}
	// PoW header must decode to a JSON object with the solved answer.
	var pow struct {
		Answer int64 `json:"answer"`
	}
	raw, err := base64.StdEncoding.DecodeString(gotPowHeader)
	if err != nil {
		t.Fatalf("pow header not base64: %v", err)
	}
	if err := json.Unmarshal(raw, &pow); err != nil {
		t.Fatalf("pow header not JSON: %v", err)
	}
	if pow.Answer != 7 {
		t.Fatalf("pow answer = %d, want 7", pow.Answer)
	}
}

func TestChatCompletionStream(t *testing.T) {
	srv := mockDeepSeek(t, testSSE, nil)
	defer srv.Close()
	c := NewClient(srv.URL, "tok-abc", "", srv.Client())
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	res, err := c.ChatCompletion(ctx, []Message{{Role: "user", Content: "hi"}}, ChatOptions{
		Model: "deepseek-chat", ResponseModel: "deepseek-chat", Stream: true,
	})
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
		`"reasoning_content":"let me think"`,
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

func TestChatCompletionEmptyPrompt(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", "tok", "", nil)
	_, err := c.ChatCompletion(context.Background(), []Message{{Role: "user", Content: "  "}}, ChatOptions{})
	if we, ok := err.(*WebError); !ok || we.Status != 400 {
		t.Fatalf("expected 400 WebError, got %v", err)
	}
}

func TestChatCompletionThinkingEnabled(t *testing.T) {
	var modelType string
	srv := mockDeepSeek(t, testSSE, func(r *http.Request) {
		var body struct {
			ModelType string `json:"model_type"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		modelType = body.ModelType
	})
	defer srv.Close()
	c := NewClient(srv.URL, "tok-abc", "", srv.Client())
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, err := c.ChatCompletion(ctx, []Message{{Role: "user", Content: "hi"}},
		ChatOptions{Model: "deepseek-reasoner", ThinkingEnabled: true})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	if modelType != "thinking" {
		t.Fatalf("model_type = %q, want thinking", modelType)
	}
}
