// Hadi — opencode-max rewritten in Go.
// AI proxy with IP rotation + multi-account key pool.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
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
	"github.com/mcptears/opencode-max/store"
	"github.com/mcptears/opencode-max/types"
	"github.com/mcptears/opencode-max/wire"
)

func main() {
	cfg := config.Load()
	log.Printf("Hadi starting on :%d", cfg.Port)

	// Database for metrics/quota.
	database, err := db.Open("")
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
	provs, _ := providers.Load(providerPath)

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
		Providers: func() []types.ProviderConfig { return provs },
		HTTP:      httpClient,
		Metrics:   metricsAdapter,
		DefaultCooldown: time.Duration(cfg.DefaultCooldownMs) * time.Millisecond,
		MaxRetries:      cfg.MaxRetries,
	}
	_ = qt

	deps := api.Deps{
		Pool:       poolAdapter,
		Rotator:    rotatorAdapter,
		Metrics:    metricsAdapter,
		Providers:  wire.NewProviderStore(providerPath),
		Settings:   &wire.SettingsStore{S: settingsStore},
		Accounts:   &wire.AccountStore{S: accountStore},
		Proxies:    &wire.ProxyStore{S: store.NewProxyStore(cfg.ProxiesFile)},
		Scraper:    &wire.ScraperStore{},
		ScraperJob: &wire.ScraperJob{},
		WebAuth:    &wire.WebAuth{HTTP: httpClient},
		Upstream:   upstream,
	}

	srv := api.NewServer(deps)

	// Graceful shutdown.
	httpSrv := &http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), Handler: srv.Handler()}

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
