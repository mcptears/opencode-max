// Package config loads the process-level RuntimeConfig from environment
// variables and reads the accounts and proxy pool files. It mirrors
// src/config.ts: same env var names, same defaults, same file formats.
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/mcptears/opencode-max/types"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil {
		return fallback
	}
	return n
}

func envInt64(key string, fallback int64) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(key)), 10, 64)
	if err != nil {
		return fallback
	}
	return n
}

// Load builds the RuntimeConfig from environment variables, applying the
// same defaults as the TypeScript CONFIG object.
func Load() types.RuntimeConfig {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	return types.RuntimeConfig{
		Port:              envInt("PORT", 8080),
		UpstreamBase:      strings.TrimRight(envOr("UPSTREAM_BASE", types.DefaultUpstreamBase), "/"),
		AccountsFile:      envOr("ACCOUNTS_FILE", filepath.Join(cwd, "accounts.json")),
		ProxiesFile:       envOr("PROXIES_FILE", filepath.Join(cwd, "proxies.json")),
		MaxRetries:        envInt("MAX_RETRIES", 5),
		RetryBaseMs:       envInt64("RETRY_BASE_MS", 1000),
		RetryMaxMs:        envInt64("RETRY_MAX_MS", 30000),
		DefaultCooldownMs: envInt64("DEFAULT_COOLDOWN_MS", 300000),
		RequestTimeoutMs:  envInt64("REQUEST_TIMEOUT_MS", 120000),
	}
}

// LoadAccounts reads accounts.json (a bare array or an {"accounts": [...]}
// wrapper), validates each entry and returns the pool sorted by priority
// ascending (1 = highest priority first).
func LoadAccounts(path string) ([]types.AccountConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("accounts file not found: %s (copy accounts.example.json to get started): %w", path, err)
	}
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("accounts file is not valid JSON: %s: %w", path, err)
	}
	var list []any
	switch v := raw.(type) {
	case []any:
		list = v
	case map[string]any:
		arr, ok := v["accounts"].([]any)
		if !ok {
			return nil, fmt.Errorf("accounts file must contain an array: %s", path)
		}
		list = arr
	default:
		return nil, fmt.Errorf("accounts file must contain an array: %s", path)
	}
	accounts := make([]types.AccountConfig, 0, len(list))
	for i, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("invalid account entry at index %d (must be an object)", i)
		}
		id, _ := m["id"].(string)
		provider, _ := m["provider"].(string)
		_, apiKeyIsString := m["apiKey"].(string)
		_, priorityIsNumber := m["priority"].(float64)
		if strings.TrimSpace(id) == "" || strings.TrimSpace(provider) == "" || !apiKeyIsString || !priorityIsNumber {
			preview, _ := json.Marshal(item)
			if len(preview) > 120 {
				preview = preview[:120]
			}
			return nil, fmt.Errorf("invalid account entry at index %d (id/provider/apiKey/priority required): %s", i, preview)
		}
		var a types.AccountConfig
		if err := json.NewDecoder(bytes.NewReader(mustMarshal(m))).Decode(&a); err != nil {
			return nil, fmt.Errorf("invalid account entry at index %d: %w", i, err)
		}
		accounts = append(accounts, a)
	}
	sort.SliceStable(accounts, func(i, j int) bool { return accounts[i].Priority < accounts[j].Priority })
	return accounts, nil
}

func mustMarshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// v came from a successful json.Unmarshal, so this cannot fail.
		panic(err)
	}
	return b
}

func splitProxies(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// LoadProxies builds the proxy pool. The PROXY_LIST env var (comma-separated)
// wins; otherwise proxies.json is read (bare array or {"proxies": [...]}
// wrapper). A missing file means direct egress — not an error.
func LoadProxies(path string) ([]string, error) {
	if env := strings.TrimSpace(os.Getenv("PROXY_LIST")); env != "" {
		return splitProxies(env), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("read proxies file %s: %w", path, err)
	}
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("proxies file is not valid JSON: %s: %w", path, err)
	}
	var list []any
	switch v := raw.(type) {
	case []any:
		list = v
	case map[string]any:
		if arr, ok := v["proxies"].([]any); ok {
			list = arr
		}
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out, nil
}
