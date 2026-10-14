package types

import "testing"

func TestProxyModeEffective(t *testing.T) {
	falsePtr := false
	cases := []struct {
		name string
		acct AccountConfig
		want string
	}{
		{"legacy default (nil useProxy) is pool", AccountConfig{}, "pool"},
		{"legacy useProxy false is off", AccountConfig{UseProxy: &falsePtr}, "off"},
		{"explicit off", AccountConfig{ProxyMode: "off"}, "off"},
		{"explicit pool", AccountConfig{ProxyMode: "pool"}, "pool"},
		{"explicit single", AccountConfig{ProxyMode: "single", ProxyURL: "http://proxy.example.com:8080"}, "single"},
		{"unknown mode falls back to legacy pool", AccountConfig{ProxyMode: "random"}, "pool"},
		{"unknown mode with useProxy false falls back to off", AccountConfig{ProxyMode: "random", UseProxy: &falsePtr}, "off"},
	}
	for _, c := range cases {
		if got := c.acct.ProxyModeEffective(); got != c.want {
			t.Errorf("%s: ProxyModeEffective() = %q, want %q", c.name, got, c.want)
		}
		if enabled := c.acct.ProxyEnabled(); enabled != (c.want != "off") {
			t.Errorf("%s: ProxyEnabled() = %v, want %v (mode %q)", c.name, enabled, c.want != "off", c.want)
		}
	}
}
