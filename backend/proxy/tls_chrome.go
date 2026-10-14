package proxy

import (
	"context"
	"net"
	"net/http"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
)

// ChromeTLSClone returns a copy of t whose TLS handshakes impersonate
// Google Chrome (ClientHello cipher suites, extensions and order match a
// real Chrome via uTLS). Go's stock crypto/tls has a highly distinctive
// JA3 fingerprint that bot-mitigation WAFs (e.g. Qwen's Baxia / Aliyun)
// flag on sight; this makes direct-HTTPS connections look like a browser.
//
// Notes:
//   - Applies to non-proxied HTTPS (Go never calls DialTLSContext for the
//     inner handshake of a CONNECT tunnel; see http.Transport docs).
//   - The clone shares nothing mutable with the original except the
//     dialer/proxy funcs, which are read-only after construction.
func ChromeTLSClone(t *http.Transport) *http.Transport {
	base := t
	if base == nil {
		if dt, ok := http.DefaultTransport.(*http.Transport); ok {
			base = dt.Clone()
		} else {
			base = &http.Transport{}
		}
	} else {
		base = base.Clone()
	}
	// Capture the dialer before overwriting DialTLSContext below; the
	// closure must not recurse into base.DialTLSContext.
	dialCtx := base.DialContext
	if dialCtx == nil {
		d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
		dialCtx = d.DialContext
	}
	base.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		raw, err := dialCtx(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		host := addr
		if h, _, err := net.SplitHostPort(addr); err == nil {
			host = h
		} else {
			host = strings.TrimSuffix(addr, ":443")
		}
		uc := utls.UClient(raw, &utls.Config{
			ServerName: host,
		}, utls.HelloChrome_Auto)
		if err := uc.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, err
		}
		return uc, nil
	}
	return base
}
