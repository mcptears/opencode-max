// Hadi — opencode-max rewritten in Go.
// AI proxy with IP rotation + multi-account key pool.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/mcptears/opencode-max/api"
	"github.com/mcptears/opencode-max/config"
	"github.com/mcptears/opencode-max/db"
	"github.com/mcptears/opencode-max/metrics"
	"github.com/mcptears/opencode-max/pool"
	"github.com/mcptears/opencode-max/providers"
	"github.com/mcptears/opencode-max/proxy"
	"github.com/mcptears/opencode-max/quota"
	"github.com/mcptears/opencode-max/zaitokens"
	"github.com/mcptears/opencode-max/store"
	"github.com/mcptears/opencode-max/types"
	"github.com/mcptears/opencode-max/wire"
)

func main() {
	cfg := config.Load()
	log.Printf("Hadi starting on :%d", cfg.Port)

	// Database for metrics/quota.
	database, err := db.Open(db.DataDir())
	if err != nil {
		log.Printf("warning: db open: %v", err)
	}

	// Account store.
	accountStore := store.NewAccountStore(cfg.AccountsFile)
	accounts, err := config.LoadAccounts(cfg.AccountsFile)
	if err != nil {
		log.Printf("warning: %v", err)
		accounts = nil
	}

	// Proxy rotator.
	proxylist, _ := config.LoadProxies(cfg.ProxiesFile)
	rotator := proxy.New(proxylist)

	// Account pool.
	p := pool.New(accounts, pool.Options{DefaultCooldownMs: time.Duration(cfg.DefaultCooldownMs) * time.Millisecond})

	// Quota tracker.
	qt := quota.New(database, 0)

	// Metrics.
	m := metrics.New(database)

	// Providers.
	providerPath := providers.DefaultPath()
	providerStore := wire.NewProviderStore(providerPath)

	// Settings.
	settingsStore := store.NewSettingsStore(store.DefaultSettingsPath())

	// HTTP client for direct egress.
	httpClient := &http.Client{Timeout: time.Duration(cfg.RequestTimeoutMs) * time.Millisecond}

	// Wire adapters.
	poolAdapter := &wire.PoolAdapter{P: p, DefaultCooldown: time.Duration(cfg.DefaultCooldownMs) * time.Millisecond}
	rotatorAdapter := &wire.RotatorAdapter{R: rotator}
	metricsAdapter := &wire.MetricsAdapter{M: m}

	// Upstream client.
	upstream := &wire.Upstream{
		Pool:      p,
		Rotator:   rotator,
		Providers: func() []types.ProviderConfig { return providerStore.LoadTypes() },
		HTTP:      httpClient,
		Metrics:   metricsAdapter,
		DefaultCooldown: time.Duration(cfg.DefaultCooldownMs) * time.Millisecond,
		MaxRetries:      cfg.MaxRetries,
		ZaiTokenPool:    zaitokens.NewStore(database),
		OnZaiPoolEmpty: func() { api.TriggerZaiCollect(20) },
	}
	_ = qt

	deps := api.Deps{
		Pool:       poolAdapter,
		Rotator:    rotatorAdapter,
		Metrics:    metricsAdapter,
		Providers:  providerStore,
		Settings:   &wire.SettingsStore{S: settingsStore},
		Accounts:   &wire.AccountStore{S: accountStore},
		Proxies:    &wire.ProxyStore{S: store.NewProxyStore(cfg.ProxiesFile)},
		Scraper:    &wire.ScraperStore{},
		ScraperJob: &wire.ScraperJob{},
		WebAuth:    &wire.WebAuth{HTTP: httpClient},
		Upstream:   upstream,
		ZaiTokens:  zaitokens.NewStore(database),
	}

	srv := api.NewServer(deps)

	// Static React dashboard at /dashboard (SPA with index.html fallback).
	// FRONTEND_DIST points at the production build; when missing the server
	// runs in API-only mode.
	handler := srv.Handler()
	if spa, ok := spaHandler(); ok {
		mux := http.NewServeMux()
		mux.Handle("/dashboard", spa)
		mux.Handle("/dashboard/", spa)
		// Root redirects to the dashboard for convenience.
		mux.HandleFunc("/{$}", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/dashboard/", http.StatusFound)
		})
		mux.Handle("/", handler)
		handler = mux
	}

	// Graceful shutdown.
	httpSrv := &http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), Handler: handler}

	go func() {
		log.Printf("listening on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("shutting down...")
	httpSrv.Close()
}

// spaHandler serves the React production build at /dashboard with an
// index.html fallback for SPA routes. It returns ok=false when the dist
// directory is missing, in which case the server runs API-only.
func spaHandler() (http.Handler, bool) {
	distDir := os.Getenv("FRONTEND_DIST")
	if distDir == "" {
		distDir = "./frontend/dist"
	}
	fi, err := os.Stat(distDir)
	if err != nil || !fi.IsDir() {
		log.Printf("warning: frontend dist not found at %s — API-only mode", distDir)
		return nil, false
	}
	index := filepath.Join(distDir, "index.html")
	absDist, err := filepath.Abs(distDir)
	if err != nil {
		log.Printf("warning: cannot resolve frontend dist %s — API-only mode", distDir)
		return nil, false
	}
	log.Printf("serving dashboard from %s", absDist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/dashboard")
		if rel == "" || rel == "/" || strings.Contains(rel, "..") {
			http.ServeFile(w, r, index)
			return
		}
		clean := filepath.Clean("/" + rel)
		abs, err := filepath.Abs(filepath.Join(distDir, clean))
		if err != nil || (abs != absDist && !strings.HasPrefix(abs, absDist+string(os.PathSeparator))) {
			http.ServeFile(w, r, index)
			return
		}
		if st, err := os.Stat(abs); err == nil && !st.IsDir() {
			http.ServeFile(w, r, abs)
			return
		}
		http.ServeFile(w, r, index)
	}), true
}
