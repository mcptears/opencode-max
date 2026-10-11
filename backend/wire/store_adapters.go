package wire

import (
	"encoding/json"

	"github.com/mcptears/opencode-max/api"
	"github.com/mcptears/opencode-max/providers"
	"github.com/mcptears/opencode-max/store"
	"github.com/mcptears/opencode-max/types"
)

// ---------------------------------------------------------------------------
// ProviderStore: file-backed provider registry -> api.ProviderStore
// ---------------------------------------------------------------------------

type ProviderStore struct {
	path string
}

func NewProviderStore(path string) *ProviderStore { return &ProviderStore{path: path} }

func (s *ProviderStore) Load() []api.ProviderConfig {
	ps, _ := providers.Load(s.path)
	out := make([]api.ProviderConfig, len(ps))
	for i, p := range ps {
		out[i] = toAPIProvider(p)
	}
	return out
}

func (s *ProviderStore) Save(ps []api.ProviderConfig) {
	out := make([]types.ProviderConfig, len(ps))
	for i, p := range ps {
		out[i] = fromAPIProvider(p)
	}
	_ = providers.Save(s.path, out)
}

func toAPIProvider(p types.ProviderConfig) api.ProviderConfig {
	// Same JSON shape; round-trip for the Protocol string type.
	var out api.ProviderConfig
	b, _ := json.Marshal(p)
	_ = json.Unmarshal(b, &out)
	return out
}

func fromAPIProvider(p api.ProviderConfig) types.ProviderConfig {
	var out types.ProviderConfig
	b, _ := json.Marshal(p)
	_ = json.Unmarshal(b, &out)
	return out
}

// ---------------------------------------------------------------------------
// SettingsStore: *store.Store[types.Settings] -> api.SettingsStore
// ---------------------------------------------------------------------------

type SettingsStore struct {
	S *store.Store[types.Settings]
}

func (s *SettingsStore) Get() api.Settings {
	var out api.Settings
	b, _ := json.Marshal(s.S.LoadOrDefault(types.Settings{}))
	_ = json.Unmarshal(b, &out)
	return out
}

func (s *SettingsStore) Save(patch map[string]any) api.Settings {
	cur := s.S.LoadOrDefault(types.Settings{})
	b, _ := json.Marshal(cur)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for k, v := range patch {
		m[k] = v
	}
	b, _ = json.Marshal(m)
	var next types.Settings
	_ = json.Unmarshal(b, &next)
	_ = s.S.Save(next)
	return s.Get()
}

func (s *SettingsStore) FilePath() string { return s.S.Path() }

// ---------------------------------------------------------------------------
// AccountStore: *store.Store[[]types.AccountConfig] -> api.AccountStore
// ---------------------------------------------------------------------------

type AccountStore struct {
	S *store.Store[[]types.AccountConfig]
}

func (s *AccountStore) Read() []api.AccountConfig {
	accs := s.S.LoadOrDefault(nil)
	out := make([]api.AccountConfig, len(accs))
	for i, a := range accs {
		out[i] = toAPIAccount(a)
	}
	return out
}

func (s *AccountStore) Write(accounts []api.AccountConfig) {
	out := make([]types.AccountConfig, len(accounts))
	for i, a := range accounts {
		out[i] = fromAPIAccount(a)
	}
	_ = s.S.Save(out)
}

// ---------------------------------------------------------------------------
// ProxyStore: file-backed proxy list -> api.ProxyStore
// ---------------------------------------------------------------------------

type ProxyStore struct {
	S *store.Store[[]string]
}

func (s *ProxyStore) Read() []string { return s.S.LoadOrDefault(nil) }

func (s *ProxyStore) Write(proxies []string) { _ = s.S.Save(proxies) }

// ---------------------------------------------------------------------------
// Scraper stubs (not implemented in Go rewrite yet)
// ---------------------------------------------------------------------------

type ScraperStore struct{}

func (s *ScraperStore) Load() []api.ScraperProvider        { return nil }
func (s *ScraperStore) Save(p []api.ScraperProvider)       {}
func (s *ScraperStore) TestProxy(proxyURL string) bool     { return false }

type ScraperJob struct{}

func (s *ScraperJob) Status() any { return map[string]any{"running": false} }
func (s *ScraperJob) Start() bool { return false }
