package store

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/mcptears/opencode-max/types"
)

func boolPtr(b bool) *bool { return &b }

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "accounts.json")
	s := NewAccountStore(path)
	accounts := []types.AccountConfig{
		{ID: "a", Name: "A", Provider: "opencode-zen", APIKey: "k1", Priority: 1},
		{ID: "b", Name: "B", Provider: "qwen", APIKey: "", Priority: 2, Cookies: "c=1", UseProxy: boolPtr(false)},
	}
	if err := s.Save(accounts); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded) != 2 || loaded[0].ID != "a" || loaded[1].Cookies != "c=1" {
		t.Fatalf("round trip mismatch: %+v", loaded)
	}
	if loaded[1].UseProxy == nil || *loaded[1].UseProxy {
		t.Error("useProxy=false not preserved through round trip")
	}
	if loaded[0].UseProxy != nil {
		t.Error("absent useProxy should stay nil")
	}
}

func TestSavePermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "settings.json") // nested dir is created
	s := NewSettingsStore(path)
	if err := s.Save(types.Settings{Port: 8080}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("perms = %o, want 600", fi.Mode().Perm())
	}
	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Port != 8080 {
		t.Errorf("Port = %d, want 8080", loaded.Port)
	}
}

func TestLoadMissingAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	s := NewProxyStore(filepath.Join(dir, "nope.json"))
	if _, err := s.Load(); err == nil {
		t.Error("missing file should error")
	}
	if got := s.LoadOrDefault([]string{"d"}); len(got) != 1 || got[0] != "d" {
		t.Errorf("LoadOrDefault = %v, want [d]", got)
	}
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	s2 := NewProxyStore(bad)
	if _, err := s2.Load(); err == nil {
		t.Error("corrupt file should error")
	}
}

func TestConcurrentAccess(t *testing.T) {
	dir := t.TempDir()
	s := NewAccountStore(filepath.Join(dir, "accounts.json"))
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = s.Save([]types.AccountConfig{{ID: "a", Provider: "p", APIKey: "k", Priority: i}})
			_, _ = s.Load()
		}(i)
	}
	wg.Wait()
	loaded, err := s.Load()
	if err != nil || len(loaded) != 1 {
		t.Errorf("after concurrent use: loaded=%v err=%v", loaded, err)
	}
}

func TestProviderStoreRaw(t *testing.T) {
	dir := t.TempDir()
	s := NewProviderStore(filepath.Join(dir, "providers.json"))
	if err := s.Save(ProviderFile{Providers: []types.ProviderConfig{types.QwenPreset}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded.Providers) != 1 || loaded.Providers[0].ID != "qwen" {
		t.Errorf("mismatch: %+v", loaded)
	}
}

func TestDefaultSettingsPath(t *testing.T) {
	t.Setenv("SETTINGS_FILE", "/tmp/custom-settings.json")
	if got := DefaultSettingsPath(); got != "/tmp/custom-settings.json" {
		t.Errorf("DefaultSettingsPath = %q, want env value", got)
	}
	t.Setenv("SETTINGS_FILE", "")
	got := DefaultSettingsPath()
	if !filepath.IsAbs(got) || filepath.Base(got) != "settings.json" {
		t.Errorf("DefaultSettingsPath = %q, want absolute settings.json", got)
	}
}
