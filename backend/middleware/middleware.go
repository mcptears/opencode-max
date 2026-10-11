// Package middleware provides HTTP middleware for opencode-max:
// admin-token auth, client API token auth, permissive CORS for /v1/*,
// and structured request logging.
package middleware

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func apiError(message string, status int) map[string]any {
	return map[string]any{"error": map[string]any{"message": message, "status": status}}
}

// AdminAuth guards endpoints with the dashboard admin token. When no token is
// configured the endpoints stay open (loopback default); otherwise clients
// must present `Authorization: Bearer <token>`.
func AdminAuth(getToken func() string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := strings.TrimSpace(getToken())
			if token == "" {
				next.ServeHTTP(w, r)
				return
			}
			if r.Header.Get("Authorization") == "Bearer "+token {
				next.ServeHTTP(w, r)
				return
			}
			writeJSON(w, http.StatusUnauthorized, apiError("admin token required", 401))
		})
	}
}

// RequireAdminForMutations applies AdminAuth to POST/PUT/PATCH/DELETE only,
// mirroring the Express admin router (reads stay open).
func RequireAdminForMutations(getToken func() string) func(http.Handler) http.Handler {
	admin := AdminAuth(getToken)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
				admin(next).ServeHTTP(w, r)
			default:
				next.ServeHTTP(w, r)
			}
		})
	}
}

// ClientTokenAuth guards /v1/* with client API tokens. When no tokens are
// configured the proxy is open; otherwise clients must present one of the
// tokens as a Bearer token or via the X-Api-Key header. OPTIONS preflights
// always pass through.
func ClientTokenAuth(getTokens func() []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			tokens := getTokens()
			if len(tokens) == 0 {
				next.ServeHTTP(w, r)
				return
			}
			var bearer string
			if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
				bearer = strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
			}
			apiKey := strings.TrimSpace(r.Header.Get("X-Api-Key"))
			for _, t := range tokens {
				if (bearer != "" && bearer == t) || (apiKey != "" && apiKey == t) {
					next.ServeHTTP(w, r)
					return
				}
			}
			writeJSON(w, http.StatusUnauthorized, apiError("missing or invalid client token", 401))
		})
	}
}

// CORSV1 is permissive CORS for /v1/* so browser-based clients can call the
// proxy directly. Preflights are answered here; ClientTokenAuth lets OPTIONS
// through too.
func CORSV1(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key")
		h.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

// RequestLogger logs method, path, status and latency for every request.
func RequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(ww, r)
		slog.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.status,
			"ms", time.Since(start).Milliseconds(),
		)
	})
}
