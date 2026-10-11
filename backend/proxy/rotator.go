// Package proxy implements a thread-safe round-robin egress proxy pool with
// health checking, mirroring the TypeScript IpRotator.
//
// OpenCode Zen keys its rate-limit bucket on the raw egress IP, so a real
// egress change requires routing through a different proxy. The rotation
// skips proxies that fail repeatedly and revives them when they recover.
// When no proxies are configured, egress is direct and the IP family itself
// can be rotated: Zen treats IPv4 and IPv6 as separate buckets.
package proxy

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/proxy"
)

// RedactProxy hides credentials when displaying proxy URLs.
func RedactProxy(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		if i := strings.Index(raw, "://"); i >= 0 {
			rest := raw[i+3:]
			if at := strings.Index(rest, "@"); at >= 0 {
				return raw[:i+3] + "***@" + rest[at+1:]
			}
		}
		return raw
	}
	if u.User != nil {
		u.User = nil
		s := u.String()
		if i := strings.Index(s, "://"); i >= 0 {
			return s[:i+3] + "***@" + s[i+3:]
		}
		return s
	}
	return raw
}

// EgressFamilyMode controls direct-egress IP family selection.
type EgressFamilyMode string

const (
	FamilyAuto EgressFamilyMode = "auto"
	Family4    EgressFamilyMode = "4"
	Family6    EgressFamilyMode = "6"
)

// ProxyHealth is the dashboard-facing health snapshot of one proxy.
type ProxyHealth struct {
	Proxy            string // redacted
	Healthy          bool
	Fails            int
	LastCheckedAgoMs int64
	QualityOk        int
	QualityFail      int
	QualityLatencyMs int64
}

// ProxyQuality tracks real-traffic quality for one proxy.
type ProxyQuality struct {
	Ok          int
	Fail        int
	ConsecFails int
	LatencyEma  int64
}

type healthState struct {
	healthy     bool
	fails       int
	lastChecked time.Time
}

// Status is the dashboard-facing snapshot of the rotator.
type Status struct {
	Proxies      int
	CurrentIndex int
	Current      string // "" = direct
	Rotations    int64
	Family       int
	FamilyMode   EgressFamilyMode
	DualStack    bool
	Health       []ProxyHealth
}

// Rotator is a round-robin egress proxy pool. Safe for concurrent use.
type Rotator struct {
	mu             sync.RWMutex
	proxies        []string
	index          int
	health         map[string]*healthState
	quality        map[string]*ProxyQuality
	familyMode     EgressFamilyMode
	dualStack      bool
	family         int // 4 or 6
	rotations      int64
	autoDropFails  int
	onHealthChange func(proxy string, healthy bool)
	onProxyDropped func(proxy string, consecFails int)
	stopCh         chan struct{}
	wg             sync.WaitGroup
}

// Option configures a Rotator.
type Option func(*Rotator)

// WithAutoDropFails sets how many consecutive real-request failures drop a
// proxy (0 disables auto-drop).
func WithAutoDropFails(n int) Option {
	return func(r *Rotator) { r.autoDropFails = n }
}

// WithHealthChangeHook fires on healthy<->unhealthy transitions.
func WithHealthChangeHook(f func(proxy string, healthy bool)) Option {
	return func(r *Rotator) { r.onHealthChange = f }
}

// WithProxyDroppedHook fires when a proxy is auto-dropped.
func WithProxyDroppedHook(f func(proxy string, consecFails int)) Option {
	return func(r *Rotator) { r.onProxyDropped = f }
}

// New creates a rotator over the given proxy URLs ("" = direct egress).
func New(proxies []string, opts ...Option) *Rotator {
	r := &Rotator{
		proxies:       append([]string{}, proxies...),
		health:        make(map[string]*healthState),
		quality:       make(map[string]*ProxyQuality),
		familyMode:    FamilyAuto,
		family:        4,
		autoDropFails: 5,
	}
	for _, o := range opts {
		o(r)
	}
	return r
}

// ConfigureEgress sets family rotation: FamilyAuto alternates v4/v6 on
// dual-stack hosts; Family4/Family6 pin the family.
func (r *Rotator) ConfigureEgress(mode EgressFamilyMode, dualStack bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if mode != "" {
		r.familyMode = mode
	}
	r.dualStack = dualStack
}

// CurrentFamily returns the effective IP family for direct egress right now.
func (r *Rotator) CurrentFamily() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	switch r.familyMode {
	case Family4:
		return 4
	case Family6:
		return 6
	default:
		if r.dualStack {
			return r.family
		}
		return 4
	}
}

// EgressLabel returns a human-readable current egress (credentials redacted).
func (r *Rotator) EgressLabel() string {
	if p := r.Current(); p != "" {
		return RedactProxy(p)
	}
	return fmt.Sprintf("direct (IPv%d)", r.CurrentFamily())
}

// Count returns the number of configured proxies.
func (r *Rotator) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.proxies)
}

// RotationsCount returns how many times the egress rotated.
func (r *Rotator) RotationsCount() int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.rotations
}

// RawProxies returns a copy of the unredacted proxy list.
func (r *Rotator) RawProxies() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, len(r.proxies))
	copy(out, r.proxies)
	return out
}

// eligible returns healthy proxies, or all of them when none are healthy.
// Call with mu held.
func (r *Rotator) eligibleLocked() []string {
	var healthy []string
	for _, p := range r.proxies {
		if st, ok := r.health[p]; !ok || st.healthy {
			healthy = append(healthy, p)
		}
	}
	if len(healthy) > 0 {
		return healthy
	}
	return r.proxies
}

// Current returns the currently selected proxy URL, or "" for direct.
func (r *Rotator) Current() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	pool := r.eligibleLocked()
	if len(pool) == 0 {
		return ""
	}
	return pool[r.index%len(pool)]
}

// Rotate advances to the next proxy. Returns the newly selected proxy
// ("" = direct). With no proxies and auto family mode on a dual-stack host,
// the IP family itself rotates.
func (r *Rotator) Rotate() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	pool := r.eligibleLocked()
	if len(pool) == 0 {
		if r.familyMode == FamilyAuto && r.dualStack {
			if r.family == 4 {
				r.family = 6
			} else {
				r.family = 4
			}
			r.rotations++
		}
		return ""
	}
	r.index = (r.index + 1) % len(pool)
	r.rotations++
	return pool[r.index%len(pool)]
}

// SetProxies hot-swaps the proxy list (dashboard edits), keeping the
// rotation position sane and dropping state for removed proxies.
func (r *Rotator) SetProxies(proxies []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.proxies = append([]string{}, proxies...)
	keep := make(map[string]struct{}, len(proxies))
	for _, p := range proxies {
		keep[p] = struct{}{}
	}
	for k := range r.health {
		if _, ok := keep[k]; !ok {
			delete(r.health, k)
		}
	}
	for k := range r.quality {
		if _, ok := keep[k]; !ok {
			delete(r.quality, k)
		}
	}
	if r.index >= len(r.proxies) {
		r.index = 0
	}
}

// RecordProxyResult records a real-traffic result for a proxy. ok=false means
// the request never reached upstream (network failure/timeout) — the proxy's
// fault. HTTP 429/5xx responses are NOT proxy faults (upstream was reached).
// Proxies with too many consecutive failures are auto-dropped (unless they'd
// be the last one left).
func (r *Rotator) RecordProxyResult(proxyURL string, ok bool, latencyMs int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	q, exists := r.quality[proxyURL]
	if !exists {
		q = &ProxyQuality{}
		r.quality[proxyURL] = q
	}
	if ok {
		q.Ok++
		q.ConsecFails = 0
		if q.LatencyEma > 0 {
			q.LatencyEma = int64(float64(q.LatencyEma)*0.7 + float64(latencyMs)*0.3 + 0.5)
		} else {
			q.LatencyEma = latencyMs
		}
		return
	}
	q.Fail++
	q.ConsecFails++
	threshold := r.autoDropFails
	if threshold <= 0 || q.ConsecFails < threshold || len(r.proxies) <= 1 {
		return
	}
	kept := false
	for _, p := range r.proxies {
		if p == proxyURL {
			kept = true
			break
		}
	}
	if !kept {
		return
	}
	next := r.proxies[:0]
	for _, p := range r.proxies {
		if p != proxyURL {
			next = append(next, p)
		}
	}
	r.proxies = next
	delete(r.health, proxyURL)
	delete(r.quality, proxyURL)
	if r.index >= len(r.proxies) {
		r.index = 0
	}
	if hook := r.onProxyDropped; hook != nil {
		go hook(proxyURL, q.ConsecFails)
	}
}

// QualityOf returns quality stats for one proxy, or nil when unknown.
func (r *Rotator) QualityOf(proxyURL string) *ProxyQuality {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if q, ok := r.quality[proxyURL]; ok {
		out := *q
		return &out
	}
	return nil
}

// IsHealthy reports whether a proxy is currently considered healthy
// (unknown proxies default to healthy).
func (r *Rotator) IsHealthy(proxyURL string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	st, ok := r.health[proxyURL]
	return !ok || st.healthy
}

// directDialContext pins the dial to an IP family: 6 forces tcp6, else tcp4.
func directDialContext(family int) func(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		switch network {
		case "tcp", "tcp4", "tcp6":
			if family == 6 {
				network = "tcp6"
			} else {
				network = "tcp4"
			}
		}
		return d.DialContext(ctx, network, addr)
	}
}

// dialContextFor builds a DialContext routing through the proxy (SOCKS5 via
// golang.org/x/net/proxy, HTTP(S) via CONNECT handled by http.Transport), or
// a direct family-pinned dialer when proxyURL is "".
func dialContextFor(proxyURL string, family int) func(ctx context.Context, network, addr string) (net.Conn, error) {
	if proxyURL == "" {
		return directDialContext(family)
	}
	u, err := url.Parse(proxyURL)
	if err != nil {
		return directDialContext(family)
	}
	switch strings.ToLower(u.Scheme) {
	case "socks5", "socks5h":
		dialer, err := proxy.FromURL(u, &net.Dialer{Timeout: 30 * time.Second})
		if err != nil {
			return directDialContext(family)
		}
		if cd, ok := dialer.(proxy.ContextDialer); ok {
			return cd.DialContext
		}
		return func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialer.Dial(network, addr)
		}
	default:
		// HTTP/HTTPS proxies are handled by Transport.Proxy; the dialer
		// stays direct and family-pinned.
		return directDialContext(family)
	}
}

// Transport returns an *http.Transport routing through the given proxy
// ("" = direct, family-pinned). Callers should reuse the returned transport.
func (r *Rotator) Transport(proxyURL string) *http.Transport {
	family := r.CurrentFamily()
	tr := &http.Transport{
		DialContext:           dialContextFor(proxyURL, family),
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	if proxyURL != "" {
		if u, err := url.Parse(proxyURL); err == nil {
			switch strings.ToLower(u.Scheme) {
			case "http", "https":
				tr.Proxy = http.ProxyURL(u)
			}
		}
	}
	return tr
}

// HTTPClient returns a client routed through the proxy ("" = direct).
func (r *Rotator) HTTPClient(proxyURL string) *http.Client {
	return &http.Client{Transport: r.Transport(proxyURL), Timeout: 60 * time.Second}
}

// Status returns a dashboard-facing snapshot of the rotator.
func (r *Rotator) Status() Status {
	r.mu.RLock()
	defer r.mu.RUnlock()
	now := time.Now()
	st := Status{
		Proxies:      len(r.proxies),
		CurrentIndex: r.index,
		Rotations:    r.rotations,
		FamilyMode:   r.familyMode,
		DualStack:    r.dualStack,
	}
	pool := r.eligibleLocked()
	if len(pool) > 0 {
		st.Current = pool[r.index%len(pool)]
	}
	if r.familyMode == Family4 {
		st.Family = 4
	} else if r.familyMode == Family6 {
		st.Family = 6
	} else if r.dualStack {
		st.Family = r.family
	} else {
		st.Family = 4
	}
	st.Health = make([]ProxyHealth, 0, len(r.proxies))
	for _, p := range r.proxies {
		h := r.health[p]
		q := r.quality[p]
		ph := ProxyHealth{
			Proxy:            RedactProxy(p),
			Healthy:          true,
			Fails:            0,
			LastCheckedAgoMs: -1,
		}
		if h != nil {
			ph.Healthy = h.healthy
			ph.Fails = h.fails
			ph.LastCheckedAgoMs = now.Sub(h.lastChecked).Milliseconds()
		}
		if q != nil {
			ph.QualityOk = q.Ok
			ph.QualityFail = q.Fail
			ph.QualityLatencyMs = q.LatencyEma
		}
		st.Health = append(st.Health, ph)
	}
	return st
}

// StartHealthChecks begins periodic probing of every proxy. Two consecutive
// failures mark a proxy down. Safe to call once; subsequent calls are no-ops.
func (r *Rotator) StartHealthChecks(interval time.Duration, target string) {
	r.mu.Lock()
	if r.stopCh != nil || len(r.proxies) == 0 {
		r.mu.Unlock()
		return
	}
	r.stopCh = make(chan struct{})
	stopCh := r.stopCh
	r.mu.Unlock()

	if interval < 10*time.Second {
		interval = 10 * time.Second
	}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		r.CheckAll(target)
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				r.CheckAll(target)
			}
		}
	}()
}

// StopHealthChecks stops the periodic probing started by StartHealthChecks.
func (r *Rotator) StopHealthChecks() {
	r.mu.Lock()
	if r.stopCh == nil {
		r.mu.Unlock()
		return
	}
	close(r.stopCh)
	r.stopCh = nil
	r.mu.Unlock()
	r.wg.Wait()
}

// CheckAll probes every configured proxy.
func (r *Rotator) CheckAll(target string) {
	r.mu.RLock()
	proxies := append([]string{}, r.proxies...)
	r.mu.RUnlock()
	r.CheckProxies(proxies, target)
}

// CheckProxies probes a subset of proxies on demand.
func (r *Rotator) CheckProxies(proxies []string, target string) {
	var wg sync.WaitGroup
	for _, p := range proxies {
		wg.Add(1)
		go func(proxyURL string) {
			defer wg.Done()
			r.checkOne(proxyURL, target)
		}(p)
	}
	wg.Wait()
}

func (r *Rotator) checkOne(proxyURL, target string) {
	r.mu.RLock()
	hook := r.onHealthChange
	r.mu.RUnlock()

	client := r.HTTPClient(proxyURL)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		r.markCheckResult(proxyURL, false, hook)
		return
	}
	resp, err := client.Do(req)
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode >= 500 {
			err = fmt.Errorf("health check status %d", resp.StatusCode)
		}
	}
	r.markCheckResult(proxyURL, err == nil, hook)
}

// markCheckResult records a health-check outcome. Two consecutive failures
// mark a proxy down; any success revives it. Call without mu held.
func (r *Rotator) markCheckResult(proxyURL string, ok bool, hook func(string, bool)) {
	r.mu.Lock()
	st, exists := r.health[proxyURL]
	if !exists {
		st = &healthState{healthy: true}
		r.health[proxyURL] = st
	}
	if !ok {
		st.fails++
		if st.healthy && st.fails >= 2 {
			st.healthy = false
			if hook != nil {
				go hook(proxyURL, false)
			}
		}
		st.lastChecked = time.Now()
		r.mu.Unlock()
		return
	}
	wasUnhealthy := !st.healthy
	st.healthy = true
	st.fails = 0
	st.lastChecked = time.Now()
	r.mu.Unlock()
	if wasUnhealthy && hook != nil {
		go hook(proxyURL, true)
	}
}
