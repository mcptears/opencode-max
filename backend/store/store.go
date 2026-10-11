// Package store provides a generic mutex-guarded JSON file store used for
// accounts, providers, settings and proxies. Writes are atomic (temp file +
// rename) with 0600 permissions so credentials are never world-readable,
// mirroring the { mode: 0o600 } writes in the TypeScript sources.
package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/mcptears/opencode-max/types"
)

// Store is a concurrency-safe JSON file store for values of type T.
type Store[T any] struct {
	mu   sync.Mutex
	path string
}

// New creates a Store for the given file path.
func New[T any](path string) *Store[T] {
	return &Store[T]{path: path}
}

// Path returns the underlying file path.
func (s *Store[T]) Path() string {
	return s.path
}

// Load reads and parses the JSON file. It returns an error when the file is
// missing or corrupt.
func (s *Store[T]) Load() (T, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var v T
	data, err := os.ReadFile(s.path)
	if err != nil {
		return v, fmt.Errorf("read %s: %w", s.path, err)
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return v, fmt.Errorf("parse %s: %w", s.path, err)
	}
	return v, nil
}

// LoadOrDefault returns the stored value, or def when the file is missing
// or corrupt.
func (s *Store[T]) LoadOrDefault(def T) T {
	v, err := s.Load()
	if err != nil {
		return def
	}
	return v
}

// Save serializes v as indented JSON and writes it atomically with 0600
// permissions.
func (s *Store[T]) Save(v T) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", s.path, err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create dir for %s: %w", s.path, err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", s.path, err)
	}
	tmpName := tmp.Name()
	// Best-effort cleanup; a no-op after a successful rename.
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", s.path, err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod %s: %w", s.path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", s.path, err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("write %s: %w", s.path, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Typed stores
// ---------------------------------------------------------------------------

// NewAccountStore creates a store for the accounts.json array.
func NewAccountStore(path string) *Store[[]types.AccountConfig] {
	return New[[]types.AccountConfig](path)
}

// NewProxyStore creates a store for the proxies.json string array.
func NewProxyStore(path string) *Store[[]string] {
	return New[[]string](path)
}

// NewSettingsStore creates a store for settings.json.
func NewSettingsStore(path string) *Store[types.Settings] {
	return New[types.Settings](path)
}

// DefaultSettingsPath resolves settings.json: SETTINGS_FILE wins, otherwise
// settings.json relative to the working directory.
func DefaultSettingsPath() string {
	if p := os.Getenv("SETTINGS_FILE"); p != "" {
		return p
	}
	abs, err := filepath.Abs("settings.json")
	if err != nil {
		return "settings.json"
	}
	return abs
}

// ProviderFile is the on-disk shape of providers.json.
type ProviderFile struct {
	Providers []types.ProviderConfig `json:"providers"`
}

// NewProviderStore creates a store for the providers.json wrapper object.
// Prefer the providers package for load/save, which normalizes entries and
// falls back to defaults; this is the raw accessor.
func NewProviderStore(path string) *Store[ProviderFile] {
	return New[ProviderFile](path)
}
