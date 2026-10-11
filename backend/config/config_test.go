package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"PORT", "UPSTREAM_BASE", "ACCOUNTS_FILE", "PROXIES_FILE",
		"MAX_RETRIES", "RETRY_BASE_MS", "RETRY_MAX_MS",
		"DEFAULT_COOLDOWN_MS", "REQUEST_TIMEOUT_MS", "PROXY_LIST",
	} {
		t.Setenv(k, "")
	}
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	c := Load()
	if c.Port != 8080 {
		t.Errorf("Port = %d, want 8080", c.Port)
	}
	if c.UpstreamBase != "https://opencode.ai/zen/v1" {
		t.Errorf("UpstreamBase = %q", c.UpstreamBase)
	}
	if c.MaxRetries != 5 || c.RetryBaseMs != 1000 || c.RetryMaxMs != 30000 {
		t.Errorf("retry defaults wrong: %+v", c)
	}
	if c.DefaultCooldownMs != 300000 || c.RequestTimeoutMs != 120000 {
		t.Errorf("timing defaults wrong: %+v", c)
	}
	if !strings.HasSuffix(c.AccountsFile, "accounts.json") || !filepath.IsAbs(c.AccountsFile) {
		t.Errorf("AccountsFile = %q, want absolute accounts.json", c.AccountsFile)
	}
	if !strings.HasSuffix(c.ProxiesFile, "proxies.json") || !filepath.IsAbs(c.ProxiesFile) {
		t.Errorf("ProxiesFile = %q, want absolute proxies.json", c.ProxiesFile)
	}
}

func TestLoadFromEnv(t *testing.T) {
	clearEnv(t)
	t.Setenv("PORT", "9090")
	t.Setenv("UPSTREAM_BASE", "https://example.com/api///")
	t.Setenv("MAX_RETRIES", "3")
	t.Setenv("RETRY_BASE_MS", "250")
	t.Setenv("DEFAULT_COOLDOWN_MS", "60000")
	t.Setenv("REQUEST_TIMEOUT_MS", "5000")
	t.Setenv("ACCOUNTS_FILE", "/tmp/a.json")
	t.Setenv("PROXIES_FILE", "/tmp/p.json")
	c := Load()
	if c.Port != 9090 {
		t.Errorf("Port = %d, want 9090", c.Port)
	}
	if c.UpstreamBase != "https://example.com/api" {
		t.Errorf("UpstreamBase = %q, want trailing slashes trimmed", c.UpstreamBase)
	}
	if c.MaxRetries != 3 || c.RetryBaseMs != 250 || c.DefaultCooldownMs != 60000 || c.RequestTimeoutMs != 5000 {
		t.Errorf("env overrides wrong: %+v", c)
	}
	if c.AccountsFile != "/tmp/a.json" || c.ProxiesFile != "/tmp/p.json" {
		t.Errorf("file overrides wrong: %+v", c)
	}
}

func TestLoadInvalidEnvFallsBack(t *testing.T) {
	clearEnv(t)
	t.Setenv("PORT", "not-a-number")
	t.Setenv("MAX_RETRIES", "1.5")
	c := Load()
	if c.Port != 8080 || c.MaxRetries != 5 {
		t.Errorf("invalid env should fall back to defaults: %+v", c)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadAccounts(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "accounts.json")
	writeFile(t, path, `[
		{"id":"b","name":"B","provider":"qwen","apiKey":"k2","priority":2},
		{"id":"a","name":"A","provider":"opencode-zen","apiKey":"k1","priority":1,"cookies":"c=1","useProxy":false,"cooldownPeriod":60000,"baseUrl":"https://x.com","quotaLimit":50}
	]`)
	accounts, err := LoadAccounts(path)
	if err != nil {
		t.Fatalf("LoadAccounts: %v", err)
	}
	if len(accounts) != 2 {
		t.Fatalf("got %d accounts, want 2", len(accounts))
	}
	// Sorted by priority ascending.
	if accounts[0].ID != "a" || accounts[1].ID != "b" {
		t.Errorf("not sorted by priority: %v", accounts)
	}
	a := accounts[0]
	if a.Cookies != "c=1" || a.BaseURL != "https://x.com" || a.QuotaLimit != 50 || a.CooldownPeriod != 60000 {
		t.Errorf("optional fields wrong: %+v", a)
	}
	if a.UseProxy == nil || *a.UseProxy {
		t.Errorf("useProxy=false not preserved")
	}
	if !accounts[1].ProxyEnabled() {
		t.Errorf("absent useProxy should default to proxy-enabled")
	}
}

func TestLoadAccountsWrapperForm(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "accounts.json")
	writeFile(t, path, `{"accounts":[{"id":"a","provider":"p","apiKey":"","priority":1}]}`)
	accounts, err := LoadAccounts(path)
	if err != nil {
		t.Fatalf("LoadAccounts: %v", err)
	}
	if len(accounts) != 1 || accounts[0].ID != "a" {
		t.Errorf("wrapper form not loaded: %+v", accounts)
	}
	// Empty apiKey is allowed (keyless accounts).
}

func TestLoadAccountsErrors(t *testing.T) {
	dir := t.TempDir()
	// Missing file.
	if _, err := LoadAccounts(filepath.Join(dir, "nope.json")); err == nil {
		t.Error("missing file should error")
	} else if !strings.Contains(err.Error(), "accounts file not found") {
		t.Errorf("wrong error message: %v", err)
	}
	// Corrupt JSON.
	bad := filepath.Join(dir, "bad.json")
	writeFile(t, bad, "{oops")
	if _, err := LoadAccounts(bad); err == nil {
		t.Error("corrupt JSON should error")
	}
	// Not an array.
	arr := filepath.Join(dir, "arr.json")
	writeFile(t, arr, `{"accounts":"nope"}`)
	if _, err := LoadAccounts(arr); err == nil {
		t.Error("non-array should error")
	}
	// Invalid entry: missing priority.
	inv := filepath.Join(dir, "inv.json")
	writeFile(t, inv, `[{"id":"a","provider":"p","apiKey":"k"}]`)
	if _, err := LoadAccounts(inv); err == nil {
		t.Error("entry without priority should error")
	}
	// Invalid entry: priority as string.
	inv2 := filepath.Join(dir, "inv2.json")
	writeFile(t, inv2, `[{"id":"a","provider":"p","apiKey":"k","priority":"1"}]`)
	if _, err := LoadAccounts(inv2); err == nil {
		t.Error("entry with string priority should error")
	}
	// Empty array is fine (pool starts empty for dashboard onboarding).
	empty := filepath.Join(dir, "empty.json")
	writeFile(t, empty, `[]`)
	accounts, err := LoadAccounts(empty)
	if err != nil {
		t.Fatalf("empty array should not error: %v", err)
	}
	if len(accounts) != 0 {
		t.Errorf("empty array gave %d accounts", len(accounts))
	}
}

func TestLoadProxies(t *testing.T) {
	dir := t.TempDir()
	clearEnv(t)

	// Missing file -> empty, no error.
	proxies, err := LoadProxies(filepath.Join(dir, "nope.json"))
	if err != nil || len(proxies) != 0 {
		t.Errorf("missing file: proxies=%v err=%v", proxies, err)
	}

	// Bare array, blanks filtered.
	p1 := filepath.Join(dir, "p1.json")
	writeFile(t, p1, `["http://a:8080", "", "http://b:8080"]`)
	proxies, err = LoadProxies(p1)
	if err != nil || len(proxies) != 2 || proxies[0] != "http://a:8080" {
		t.Errorf("array form: proxies=%v err=%v", proxies, err)
	}

	// Wrapper form with non-string entries filtered.
	p2 := filepath.Join(dir, "p2.json")
	writeFile(t, p2, `{"proxies":["http://c:8080", 42, null]}`)
	proxies, err = LoadProxies(p2)
	if err != nil || len(proxies) != 1 || proxies[0] != "http://c:8080" {
		t.Errorf("wrapper form: proxies=%v err=%v", proxies, err)
	}

	// Corrupt file errors.
	p3 := filepath.Join(dir, "p3.json")
	writeFile(t, p3, "{bad")
	if _, err := LoadProxies(p3); err == nil {
		t.Error("corrupt file should error")
	}

	// PROXY_LIST env wins over the file.
	t.Setenv("PROXY_LIST", "http://env1:1, http://env2:2 ,,")
	proxies, err = LoadProxies(p1)
	if err != nil || len(proxies) != 2 || proxies[0] != "http://env1:1" || proxies[1] != "http://env2:2" {
		t.Errorf("PROXY_LIST should win: proxies=%v err=%v", proxies, err)
	}
}
