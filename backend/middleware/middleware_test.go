package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
}

func TestAdminAuth(t *testing.T) {
	// No token configured: open.
	h := AdminAuth(func() string { return "" })(okHandler())
	r := httptest.NewRequest(http.MethodPost, "/api/accounts", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Errorf("open admin should pass, got %d", w.Code)
	}

	// Token configured: missing header -> 401.
	h = AdminAuth(func() string { return "secret" })(okHandler())
	r = httptest.NewRequest(http.MethodPost, "/api/accounts", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Errorf("missing token should 401, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("error should be JSON, got %q", ct)
	}

	// Wrong token -> 401.
	r = httptest.NewRequest(http.MethodPost, "/api/accounts", nil)
	r.Header.Set("Authorization", "Bearer wrong")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Errorf("wrong token should 401, got %d", w.Code)
	}

	// Right token -> pass.
	r = httptest.NewRequest(http.MethodPost, "/api/accounts", nil)
	r.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Errorf("valid token should pass, got %d", w.Code)
	}
}

func TestRequireAdminForMutations(t *testing.T) {
	h := RequireAdminForMutations(func() string { return "secret" })(okHandler())

	// GET stays open.
	r := httptest.NewRequest(http.MethodGet, "/api/accounts", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Errorf("GET should stay open, got %d", w.Code)
	}

	// POST requires the token.
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		r = httptest.NewRequest(m, "/api/x", nil)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Errorf("%s without token should 401, got %d", m, w.Code)
		}
		r = httptest.NewRequest(m, "/api/x", nil)
		r.Header.Set("Authorization", "Bearer secret")
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Errorf("%s with token should pass, got %d", m, w.Code)
		}
	}
}

func TestClientTokenAuth(t *testing.T) {
	// No tokens: open.
	h := ClientTokenAuth(func() []string { return nil })(okHandler())
	r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Errorf("no tokens configured should be open, got %d", w.Code)
	}

	h = ClientTokenAuth(func() []string { return []string{"tok1", "tok2"} })(okHandler())

	// OPTIONS always passes.
	r = httptest.NewRequest(http.MethodOptions, "/v1/chat/completions", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Errorf("OPTIONS should pass, got %d", w.Code)
	}

	// No credential -> 401.
	r = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Errorf("missing credential should 401, got %d", w.Code)
	}

	// Bearer token.
	r = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	r.Header.Set("Authorization", "Bearer tok2")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Errorf("valid bearer should pass, got %d", w.Code)
	}

	// X-Api-Key header.
	r = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	r.Header.Set("X-Api-Key", "tok1")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Errorf("valid x-api-key should pass, got %d", w.Code)
	}

	// Wrong token.
	r = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	r.Header.Set("Authorization", "Bearer nope")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Errorf("wrong token should 401, got %d", w.Code)
	}
}

func TestCORSV1(t *testing.T) {
	h := CORSV1(okHandler())

	r := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("CORS origin header missing")
	}
	if w.Code != 200 {
		t.Errorf("GET should pass through, got %d", w.Code)
	}

	// Preflight answered directly.
	r = httptest.NewRequest(http.MethodOptions, "/v1/models", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Errorf("OPTIONS should be 204, got %d", w.Code)
	}
}
