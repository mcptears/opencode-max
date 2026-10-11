package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mcptears/opencode-max/middleware"
)

// Server holds the chi router and all HTTP handlers.
type Server struct {
	deps     Deps
	router   chi.Router
	modelsMu modelsCache
}

// NewServer wires the full HTTP surface:
//   - middleware: request logging everywhere
//   - /v1/*: CORS + client-token auth + proxy handlers
//   - /api/*: admin auth on mutating methods + admin handlers
//   - /health, /metrics: open operational endpoints
func NewServer(deps Deps) *Server {
	s := &Server{deps: deps}
	r := chi.NewRouter()

	r.Use(middleware.RequestLogger)

	// Operational endpoints (no auth, like the Express originals).
	r.Get("/health", s.handleHealth)
	r.Get("/metrics", s.handlePrometheus)

	// /v1/* proxy surface.
	r.Route("/v1", func(r chi.Router) {
		r.Use(middleware.CORSV1)
		r.Use(middleware.ClientTokenAuth(func() []string { return deps.Settings.Get().ClientTokens }))
		r.Get("/accounts", s.handleV1Accounts)
		r.Post("/rotate", s.handleV1Rotate)
		r.Get("/models", s.handleV1Models)
		r.Post("/chat/completions", s.handleProxy)
		r.Post("/messages", s.handleProxy)
		// Catch-all for any other upstream path.
		r.Handle("/*", http.HandlerFunc(s.handleProxy))
	})

	// /api/* admin surface. Mutating methods require the admin token when set.
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.RequireAdminForMutations(func() string { return deps.Settings.Get().AdminToken }))
		s.registerAdmin(r)
	})

	s.router = r
	return s
}

// Handler returns the http.Handler to serve.
func (s *Server) Handler() http.Handler { return s.router }
