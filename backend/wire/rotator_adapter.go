package wire

import (
	"net/http"
	"time"

	"github.com/mcptears/opencode-max/api"
	"github.com/mcptears/opencode-max/proxy"
)

// ---------------------------------------------------------------------------
// RotatorAdapter: *proxy.Rotator -> api.IpRotator
// ---------------------------------------------------------------------------

type RotatorAdapter struct {
	R *proxy.Rotator
}

func (a *RotatorAdapter) Status() api.RotatorStatus {
	s := a.R.Status()
	out := api.RotatorStatus{
		Proxies:      s.Proxies,
		CurrentIndex: s.CurrentIndex,
		Rotations:    int(s.Rotations),
		Family:       s.Family,
		FamilyMode:   string(s.FamilyMode),
		DualStack:    s.DualStack,
	}
	if s.Current != "" {
		out.Current = &s.Current
	}
	out.Health = make([]api.ProxyHealth, len(s.Health))
	for i, h := range s.Health {
		out.Health[i] = api.ProxyHealth{Proxy: h.Proxy, Healthy: h.Healthy}
	}
	return out
}

func (a *RotatorAdapter) Rotate() string { return a.R.Rotate() }

func (a *RotatorAdapter) Current() string { return a.R.Current() }

func (a *RotatorAdapter) CurrentFamily() int { return a.R.CurrentFamily() }

func (a *RotatorAdapter) SetProxies(proxies []string) { a.R.SetProxies(proxies) }

func (a *RotatorAdapter) RoundTripperFor(proxyURL string, family int) http.RoundTripper {
	return a.R.Transport(proxyURL)
}

func (a *RotatorAdapter) RecordProxyResult(proxyURL string, ok bool, latencyMs int64) {
	a.R.RecordProxyResult(proxyURL, ok, latencyMs)
}

func (a *RotatorAdapter) CheckProxies(proxies []string) {
	// Target the Qwen models endpoint as a health probe.
	a.R.CheckProxies(proxies, "https://chat.qwen.ai/api/v2/models")
}

func (a *RotatorAdapter) StartHealthChecks(intervalMs int64) {
	a.R.StartHealthChecks(time.Duration(intervalMs)*time.Millisecond, "https://chat.qwen.ai/api/v2/models")
}

func (a *RotatorAdapter) StopHealthChecks() { a.R.StopHealthChecks() }

func (a *RotatorAdapter) ConfigureEgress(familyMode string) {
	var mode proxy.EgressFamilyMode
	switch familyMode {
	case "4":
		mode = proxy.Family4
	case "6":
		mode = proxy.Family6
	default:
		mode = proxy.FamilyAuto
	}
	a.R.ConfigureEgress(mode, true)
}

func (a *RotatorAdapter) EgressLabel() string { return a.R.EgressLabel() }
