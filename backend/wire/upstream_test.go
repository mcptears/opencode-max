package wire

import (
	"net/http"
	"testing"
	"time"

	"github.com/mcptears/opencode-max/proxy"
	"github.com/mcptears/opencode-max/types"
)

func TestZenUserAgent(t *testing.T) {
	if got := zenUserAgent("https://opencode.ai/zen/v1"); got != "opencode/1.18.31" {
		t.Fatalf("zen base: got %q", got)
	}
	if got := zenUserAgent("https://opencode.ai/zen/go/v1"); got != "opencode/1.18.31" {
		t.Fatalf("zen go base: got %q", got)
	}
	if got := zenUserAgent("https://api.openai.com/v1"); got != "" {
		t.Fatalf("non-zen base: got %q, want empty", got)
	}
	if got := zenUserAgent(""); got != "" {
		t.Fatalf("empty base: got %q, want empty", got)
	}
}

func TestClientFor(t *testing.T) {
	direct := &http.Client{Timeout: time.Second}
	rot := proxy.New([]string{"http://proxy-a.example.com:8080", "http://proxy-b.example.com:8080"})
	u := &Upstream{Rotator: rot, HTTP: direct}

	proxyOf := func(c *http.Client) string {
		tr, ok := c.Transport.(*http.Transport)
		if !ok {
			return "<not-a-transport>"
		}
		if tr.Proxy == nil {
			return "<no-proxy-func>"
		}
		req, _ := http.NewRequest(http.MethodGet, "https://example.com/", nil)
		pu, err := tr.Proxy(req)
		if err != nil || pu == nil {
			return "<direct>"
		}
		return pu.Host
	}

	// off => the direct client itself.
	if got := u.clientFor(&types.AccountConfig{ProxyMode: "off"}); got != direct {
		t.Errorf("off mode: got %p, want direct client %p", got, direct)
	}
	// single => pinned proxy, every time.
	pinned := &types.AccountConfig{ProxyMode: "single", ProxyURL: "http://pinned.example.com:3128"}
	for i := 0; i < 2; i++ {
		if got := proxyOf(u.clientFor(pinned)); got != "pinned.example.com:3128" {
			t.Errorf("single mode call %d: proxy host = %q, want pinned", i, got)
		}
	}
	// pool => round-robin: two consecutive calls must land on different proxies.
	first := proxyOf(u.clientFor(&types.AccountConfig{ProxyMode: "pool"}))
	second := proxyOf(u.clientFor(&types.AccountConfig{ProxyMode: "pool"}))
	if first == second {
		t.Errorf("pool mode did not rotate: both calls used %q", first)
	}
	if (first != "proxy-a.example.com:8080" && first != "proxy-b.example.com:8080") ||
		(second != "proxy-a.example.com:8080" && second != "proxy-b.example.com:8080") {
		t.Errorf("pool mode used unexpected proxies: %q, %q", first, second)
	}
	// legacy account (no mode, no useProxy) => pool behaviour.
	legacy := proxyOf(u.clientFor(&types.AccountConfig{}))
	if legacy != "proxy-a.example.com:8080" && legacy != "proxy-b.example.com:8080" {
		t.Errorf("legacy account: proxy host = %q, want a pool proxy", legacy)
	}
}
