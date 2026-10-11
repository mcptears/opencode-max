package qwen

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// mockQwen is a fake chat.qwen.ai. mode switches upstream behavior:
// "ok", "risk" (FAIL_SYS_USER_VALIDATE JSON), "unauth" (401), "empty" (DONE only).
type mockQwen struct {
	t              *testing.T
	mu             sync.Mutex
	mode           string
	lastCreateBody map[string]any
	deleted        []string
}

func (m *mockQwen) setMode(mode string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.mode = mode
}

func (m *mockQwen) getMode() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mode
}

const sseBody = "data: {\"choices\":[{\"delta\":{\"phase\":\"think\",\"content\":\"hmm\"}}]}\n\n" +
	"data: {\"choices\":[{\"delta\":{\"phase\":\"answer\",\"content\":\"hello\"}}]}\n\n" +
	"data: [DONE]\n\n"

func (m *mockQwen) handler(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/w/wu.json":
		w.Write([]byte(`try{umx.wu('T2gAtestumid12345');}catch(e){}`))
	case r.URL.Path == "/api/v2/chats/" && r.Method == http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":true,"data":[]}`))
	case r.URL.Path == "/api/v2/chats/new" && r.Method == http.MethodPost:
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			m.t.Errorf("decode create body: %v", err)
		}
		m.mu.Lock()
		m.lastCreateBody = body
		m.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":true,"data":{"id":"chat-123"}}`))
	case strings.HasPrefix(r.URL.Path, "/api/v2/chat/completions") && r.Method == http.MethodPost:
		// Auth must ride on a Bearer token (logged-in).
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{}`))
			return
		}
		switch m.getMode() {
		case "risk":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"code":"FAIL_SYS_USER_VALIDATE"}`))
		case "unauth":
			w.WriteHeader(http.StatusUnauthorized)
		case "empty":
			w.Header().Set("Content-Type", "text/event-stream")
			w.Write([]byte("data: [DONE]\n\n"))
		default:
			w.Header().Set("Content-Type", "text/event-stream")
			w.Write([]byte(sseBody))
		}
	case strings.HasPrefix(r.URL.Path, "/api/v2/chats/chat-123") && r.Method == http.MethodDelete:
		m.mu.Lock()
		m.deleted = append(m.deleted, r.URL.Path)
		m.mu.Unlock()
		w.Write([]byte(`{}`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func newMock(t *testing.T) (*mockQwen, *httptest.Server, *Client) {
	t.Helper()
	m := &mockQwen{t: t, mode: "ok"}
	srv := httptest.NewServer(http.HandlerFunc(m.handler))
	t.Cleanup(srv.Close)
	c := NewClient(srv.URL)
	c.WuURL = srv.URL + "/w/wu.json"
	return m, srv, c
}

func TestValidateOK(t *testing.T) {
	_, _, c := newMock(t)
	if err := c.Validate(context.Background(), "tok123", ""); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestValidateRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	err := c.Validate(context.Background(), "bad", "")
	qe, ok := err.(*QwenError)
	if !ok || qe.Status != 401 {
		t.Fatalf("expected 401 QwenError, got %v", err)
	}
}

func TestChatCompletionNonStream(t *testing.T) {
	m, _, c := newMock(t)
	rc, err := c.ChatCompletion("tok123", "", "qwen3.7-plus", []Message{{Role: "user", Content: "hi"}}, false)
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	defer rc.Close()
	body, _ := io.ReadAll(rc)
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	msg := out["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if msg["content"] != "hello" {
		t.Fatalf("content = %v, want hello", msg["content"])
	}
	if msg["reasoning_content"] != "hmm" {
		t.Fatalf("reasoning_content = %v, want hmm", msg["reasoning_content"])
	}
	if out["object"] != "chat.completion" {
		t.Fatalf("object = %v", out["object"])
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.lastCreateBody["chat_mode"] != "normal" {
		t.Fatalf("chat_mode = %v, want normal", m.lastCreateBody["chat_mode"])
	}
	models := m.lastCreateBody["models"].([]any)
	if len(models) != 1 || models[0] != "qwen3.7-plus" {
		t.Fatalf("models = %v", m.lastCreateBody["models"])
	}
	if len(m.deleted) == 0 {
		t.Fatal("expected disposable chat to be deleted")
	}
}

func TestChatCompletionStream(t *testing.T) {
	_, _, c := newMock(t)
	rc, err := c.ChatCompletion("tok123", "", "qwen3.7-plus", []Message{{Role: "user", Content: "hi"}}, true)
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	defer rc.Close()
	body, _ := io.ReadAll(rc)
	s := string(body)
	for _, want := range []string{
		`"reasoning_content":"hmm"`,
		`"content":"hello"`,
		`"finish_reason":"stop"`,
		"data: [DONE]",
		`"role":"assistant"`,
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("stream missing %q in:\n%s", want, s)
		}
	}
}

func TestRiskControlMapsTo429(t *testing.T) {
	m, _, c := newMock(t)
	m.setMode("risk")
	_, err := c.ChatCompletion("tok123", "", "qwen3.7-plus", []Message{{Role: "user", Content: "hi"}}, false)
	qe, ok := err.(*QwenError)
	if !ok || qe.Status != 429 {
		t.Fatalf("expected 429 QwenError, got %v", err)
	}
}

func TestUnauthMapsTo401(t *testing.T) {
	m, _, c := newMock(t)
	m.setMode("unauth")
	_, err := c.ChatCompletion("tok123", "", "qwen3.7-plus", []Message{{Role: "user", Content: "hi"}}, false)
	qe, ok := err.(*QwenError)
	if !ok || qe.Status != 401 {
		t.Fatalf("expected 401 QwenError, got %v", err)
	}
}

func TestEmptyCompletionMapsTo502(t *testing.T) {
	m, _, c := newMock(t)
	m.setMode("empty")
	_, err := c.ChatCompletion("tok123", "", "qwen3.7-plus", []Message{{Role: "user", Content: "hi"}}, false)
	qe, ok := err.(*QwenError)
	if !ok || qe.Status != 502 {
		t.Fatalf("expected 502 QwenError, got %v", err)
	}
}

func TestEmptyPromptRejected(t *testing.T) {
	_, _, c := newMock(t)
	_, err := c.ChatCompletion("tok123", "", "qwen3.7-plus", []Message{{Role: "user", Content: "  "}}, false)
	qe, ok := err.(*QwenError)
	if !ok || qe.Status != 400 {
		t.Fatalf("expected 400 QwenError, got %v", err)
	}
}

func TestGuestHeadersUseBaxia(t *testing.T) {
	_, _, c := newMock(t)
	h := c.headers(context.Background(), "", "")
	if got := h.Get("bx-umidtoken"); got != "T2gAtestumid12345" {
		t.Fatalf("bx-umidtoken = %q", got)
	}
	if h.Get("bx-ua") == "" || h.Get("bx-v") != BaxiaVersion {
		t.Fatalf("missing bx-ua/bx-v: %v", h)
	}
	if h.Get("source") != "web" {
		t.Fatalf("source = %q, want web", h.Get("source"))
	}
	if h.Get("Authorization") != "" {
		t.Fatal("guest must not send Authorization")
	}
}

func TestLoggedInHeadersNoBaxia(t *testing.T) {
	_, _, c := newMock(t)
	h := c.headers(context.Background(), "tok123", "a=b")
	if h.Get("Authorization") != "Bearer tok123" {
		t.Fatalf("Authorization = %q", h.Get("Authorization"))
	}
	if h.Get("bx-umidtoken") != "" || h.Get("bx-ua") != "" {
		t.Fatal("logged-in must not send baxia headers")
	}
	if h.Get("Cookie") != "a=b" {
		t.Fatalf("Cookie = %q", h.Get("Cookie"))
	}
	if h.Get("sec-ch-ua") == "" || h.Get("Referer") != "https://chat.qwen.ai/" {
		t.Fatalf("missing browser headers: %v", h)
	}
}

func TestGuestChatMode(t *testing.T) {
	m, _, c := newMock(t)
	rc, err := c.ChatCompletion("", "", "qwen3.7-plus", []Message{{Role: "user", Content: "hi"}}, false)
	// Guest completion hits the mock's Bearer check and fails — we only care
	// that chat creation used guest mode before that.
	_ = rc
	_ = err
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.lastCreateBody["chat_mode"] != "guest" {
		t.Fatalf("chat_mode = %v, want guest", m.lastCreateBody["chat_mode"])
	}
}

func TestParseQwenDelta(t *testing.T) {
	cases := []struct {
		payload string
		kind    string
		text    string
		ok      bool
	}{
		{`{"choices":[{"delta":{"phase":"think","content":"a"}}]}`, "think", "a", true},
		{`{"choices":[{"delta":{"phase":"thinking_summary","content":"b"}}]}`, "think", "b", true},
		{`{"choices":[{"delta":{"phase":"answer","content":"c"}}]}`, "answer", "c", true},
		{`{"choices":[{"delta":{"content":"d"}}]}`, "answer", "d", true},
		{`{"choices":[{"delta":{"phase":"answer","content":""}}]}`, "", "", false},
		{`not json`, "", "", false},
		{`{"choices":[]}`, "", "", false},
		{`{"choices":[{"delta":{"phase":"other","content":"x"}}]}`, "", "", false},
	}
	for _, tc := range cases {
		kind, text, ok := ParseQwenDelta(tc.payload)
		if kind != tc.kind || text != tc.text || ok != tc.ok {
			t.Fatalf("ParseQwenDelta(%q) = (%q,%q,%v), want (%q,%q,%v)",
				tc.payload, kind, text, ok, tc.kind, tc.text, tc.ok)
		}
	}
}

func TestFlattenMessages(t *testing.T) {
	got := FlattenMessages([]Message{
		{Role: "system", Content: "be nice"},
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: "yo"},
		{Role: "user", Content: []ContentPart{{Type: "text", Text: "a"}, {Type: "text", Text: "b"}}},
		{Role: "user", Content: "   "},
	})
	want := "be nice\n\n[User]: hi\n\n[Assistant]: yo\n\n[User]: a\nb"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
