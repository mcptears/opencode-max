// Package pool implements a thread-safe, priority-ordered account pool with
// cooldown tracking, mirroring the TypeScript AccountPool.
package pool

import (
	"sort"
	"sync"
	"time"

	"github.com/mcptears/opencode-max/types"
)

// AccountConfig is the shared account model from the types package.
type AccountConfig = types.AccountConfig

// UsesProxy reports whether the account should route through the proxy pool.
// Only an explicit false opts out; unset keeps legacy proxy-on behaviour.
func UsesProxy(a AccountConfig) bool {
	return a.ProxyEnabled()
}

// AccountState is the dashboard-visible lifecycle state of an account.
type AccountState string

const (
	StateActive  AccountState = "active"
	StateCooling AccountState = "cooling_down"
	StateInvalid AccountState = "invalid"
)

// QuotaTracker is the hook for per-account rolling 5h quota tracking.
// Implemented by the quota package; the pool only reads through it.
// A limit of 0 means "use the global default".
type QuotaTracker interface {
	Usage(id string) int
	IsOverQuota(id string, limit int) bool
}

// RoutingStrategy selects how accounts are picked among usable candidates.
type RoutingStrategy string

const (
	RoutingPriority RoutingStrategy = "priority"
	RoutingLatency  RoutingStrategy = "latency"
)

// Options wires runtime settings into the pool.
type Options struct {
	// DefaultCooldownMs parks an account after a 429/quota hit.
	DefaultCooldownMs time.Duration
	// AccountConcurrency caps in-flight requests per account; <=0 = no cap.
	AccountConcurrency int
	RoutingStrategy    RoutingStrategy
}

// AccountStatus is the dashboard-facing snapshot of one account.
type AccountStatus struct {
	ID             string
	Name           string
	Provider       string
	Priority       int
	UsesProxy      bool
	ProxyMode      string // effective: off | pool | single
	ProxyURL       string // pinned proxy URL (raw; the wire adapter redacts it)
	State          AccountState
	CooldownLeft   time.Duration
	Usage5h        int
	QuotaLimit     int
	CooldownPeriod time.Duration
	BaseURL        string
	AvgLatencyMs   int64
	Inflight       int
}

// Pool is a priority-ordered account pool with cooldown tracking.
// Accounts are tried P1 -> P2 -> P3; a 429 parks the account for its
// cooldown period, after which it automatically rejoins the pool.
// All methods are safe for concurrent use.
type Pool struct {
	mu           sync.Mutex
	accounts     []AccountConfig
	coolingUntil map[string]time.Time
	invalid      map[string]struct{}
	quota        QuotaTracker
	latencyEma   map[string]int64
	inflight     map[string]int
	opts         Options
}

// New creates a pool from the given accounts, sorted by priority ascending.
func New(accounts []AccountConfig, opts Options) *Pool {
	p := &Pool{
		coolingUntil: make(map[string]time.Time),
		invalid:      make(map[string]struct{}),
		latencyEma:   make(map[string]int64),
		inflight:     make(map[string]int),
		opts:         opts,
	}
	p.accounts = sortedCopy(accounts)
	return p
}

func sortedCopy(accounts []AccountConfig) []AccountConfig {
	out := make([]AccountConfig, len(accounts))
	copy(out, accounts)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Priority < out[j].Priority })
	return out
}

// SetQuotaTracker attaches the quota tracker (wired at startup).
func (p *Pool) SetQuotaTracker(q QuotaTracker) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.quota = q
}

// SetOptions hot-swaps runtime options (dashboard edits).
func (p *Pool) SetOptions(opts Options) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.opts = opts
}

// Replace hot-swaps the pool (dashboard edits). Cooling/invalid/inflight
// state is preserved by account id; state for removed ids is dropped.
func (p *Pool) Replace(accounts []AccountConfig) {
	p.mu.Lock()
	defer p.mu.Unlock()
	known := make(map[string]struct{}, len(accounts))
	for _, a := range accounts {
		known[a.ID] = struct{}{}
	}
	for id := range p.coolingUntil {
		if _, ok := known[id]; !ok {
			delete(p.coolingUntil, id)
		}
	}
	for id := range p.invalid {
		if _, ok := known[id]; !ok {
			delete(p.invalid, id)
		}
	}
	for id := range p.inflight {
		if _, ok := known[id]; !ok {
			delete(p.inflight, id)
		}
	}
	p.accounts = sortedCopy(accounts)
}

// pruneExpiredCooling removes elapsed cooldowns. Call with mu held.
func (p *Pool) pruneExpiredCooling(now time.Time) {
	for id, until := range p.coolingUntil {
		if !until.After(now) {
			delete(p.coolingUntil, id)
		}
	}
}

func (p *Pool) find(id string) *AccountConfig {
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			return &p.accounts[i]
		}
	}
	return nil
}

func (p *Pool) usableLocked(a AccountConfig, now time.Time, checkCap bool) bool {
	if _, bad := p.invalid[a.ID]; bad {
		return false
	}
	if until, cooling := p.coolingUntil[a.ID]; cooling && until.After(now) {
		return false
	}
	if p.quota != nil && p.quota.IsOverQuota(a.ID, a.QuotaLimit) {
		return false
	}
	if checkCap && p.opts.AccountConcurrency > 0 && p.inflight[a.ID] >= p.opts.AccountConcurrency {
		return false
	}
	return true
}

// Acquire returns the highest-priority usable account for the provider.
// Over-quota, cooling, invalid and at-cap accounts are excluded; among the
// rest the least-used one wins ties so load spreads before any 429 hits.
// With RoutingLatency, the fastest-known account wins instead (unknown
// latency counts as 0 so new accounts get tried). A successful acquire
// increments the in-flight count — pair it with Release.
func (p *Pool) Acquire(provider string) *AccountConfig {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	p.pruneExpiredCooling(now)

	var usable []AccountConfig
	for _, a := range p.accounts {
		if provider != "" && a.Provider != provider {
			continue
		}
		if p.usableLocked(a, now, true) {
			usable = append(usable, a)
		}
	}
	if len(usable) == 0 {
		return nil
	}
	latency := func(id string) int64 { return p.latencyEma[id] }
	usage := func(id string) int {
		if p.quota == nil {
			return 0
		}
		return p.quota.Usage(id)
	}
	if p.opts.RoutingStrategy == RoutingLatency {
		sort.SliceStable(usable, func(i, j int) bool {
			if latency(usable[i].ID) != latency(usable[j].ID) {
				return latency(usable[i].ID) < latency(usable[j].ID)
			}
			if usable[i].Priority != usable[j].Priority {
				return usable[i].Priority < usable[j].Priority
			}
			return usage(usable[i].ID) < usage(usable[j].ID)
		})
	} else {
		sort.SliceStable(usable, func(i, j int) bool {
			if usable[i].Priority != usable[j].Priority {
				return usable[i].Priority < usable[j].Priority
			}
			if usage(usable[i].ID) != usage(usable[j].ID) {
				return usage(usable[i].ID) < usage(usable[j].ID)
			}
			return latency(usable[i].ID) < latency(usable[j].ID)
		})
	}
	picked := usable[0]
	if p.opts.AccountConcurrency > 0 {
		p.inflight[picked.ID]++
	}
	out := picked
	return &out
}

// Release frees an in-flight slot after the request finished (success or retry).
func (p *Pool) Release(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n := p.inflight[id]; n <= 1 {
		delete(p.inflight, id)
	} else {
		p.inflight[id] = n - 1
	}
}

// Count returns the number of configured accounts, optionally filtered by provider.
func (p *Pool) Count(provider string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if provider == "" {
		return len(p.accounts)
	}
	n := 0
	for _, a := range p.accounts {
		if a.Provider == provider {
			n++
		}
	}
	return n
}

// RecordLatency records a successful request latency (EMA, α=0.3).
func (p *Pool) RecordLatency(id string, ms int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if prev, ok := p.latencyEma[id]; ok {
		p.latencyEma[id] = int64(float64(prev)*0.7 + float64(ms)*0.3 + 0.5)
	} else {
		p.latencyEma[id] = ms
	}
}

// LatencyOf returns the EMA latency in ms, or -1 when unknown.
func (p *Pool) LatencyOf(id string) int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	if v, ok := p.latencyEma[id]; ok {
		return v
	}
	return -1
}

// AtCap reports whether usable accounts exist but every one is at the
// concurrency cap.
func (p *Pool) AtCap(provider string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.opts.AccountConcurrency <= 0 {
		return false
	}
	now := time.Now()
	var candidates []AccountConfig
	for _, a := range p.accounts {
		if provider != "" && a.Provider != provider {
			continue
		}
		if _, bad := p.invalid[a.ID]; bad {
			continue
		}
		if until, cooling := p.coolingUntil[a.ID]; cooling && until.After(now) {
			continue
		}
		if p.quota != nil && p.quota.IsOverQuota(a.ID, a.QuotaLimit) {
			continue
		}
		candidates = append(candidates, a)
	}
	if len(candidates) == 0 {
		return false
	}
	for _, a := range candidates {
		if p.inflight[a.ID] < p.opts.AccountConcurrency {
			return false
		}
	}
	return true
}

// HasCapacity reports whether at least one usable account is under the cap.
func (p *Pool) HasCapacity(provider string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for _, a := range p.accounts {
		if provider != "" && a.Provider != provider {
			continue
		}
		if p.usableLocked(a, now, true) {
			return true
		}
	}
	return false
}

// NextAvailableIn returns how long until the soonest cooling account of this
// provider becomes usable again; 0 when nothing is cooling.
func (p *Pool) NextAvailableIn(provider string) time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	var min time.Duration
	for id, until := range p.coolingUntil {
		if !until.After(now) {
			continue
		}
		acc := p.find(id)
		if acc == nil {
			continue
		}
		if _, bad := p.invalid[id]; bad {
			continue
		}
		if provider != "" && acc.Provider != provider {
			continue
		}
		if wait := until.Sub(now); min == 0 || wait < min {
			min = wait
		}
	}
	return min
}

// MarkLimited parks an account after a 429/quota hit. The cooldown is the
// explicit override, then the account's cooldownPeriod, then the default.
func (p *Pool) MarkLimited(id string, cooldownMs time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	cd := cooldownMs
	if cd <= 0 {
		if acc := p.find(id); acc != nil && acc.CooldownPeriod > 0 {
			cd = time.Duration(acc.CooldownPeriod) * time.Millisecond
		} else {
			cd = p.opts.DefaultCooldownMs
		}
	}
	p.coolingUntil[id] = time.Now().Add(cd)
}

// MarkInvalid flags a key as dead (401 / invalid-key 403). Skipped until reset.
func (p *Pool) MarkInvalid(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.invalid[id] = struct{}{}
	delete(p.coolingUntil, id)
}

// ResetAccount re-admits an account (dashboard reset after fixing it):
// clears both the invalid flag and any cooldown.
func (p *Pool) ResetAccount(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.invalid, id)
	delete(p.coolingUntil, id)
}

// IsInvalid reports whether the account is flagged invalid.
func (p *Pool) IsInvalid(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, bad := p.invalid[id]
	return bad
}

// AllInvalid reports whether accounts exist but every one is flagged invalid.
func (p *Pool) AllInvalid(provider string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	var pool []AccountConfig
	for _, a := range p.accounts {
		if provider == "" || a.Provider == provider {
			pool = append(pool, a)
		}
	}
	if len(pool) == 0 {
		return false
	}
	for _, a := range pool {
		if _, bad := p.invalid[a.ID]; !bad {
			return false
		}
	}
	return true
}

// Exhausted reports whether no usable account can be acquired right now.
func (p *Pool) Exhausted(provider string) bool {
	return p.Acquire(provider) == nil
}

// Status returns a dashboard-facing snapshot of every account.
func (p *Pool) Status() []AccountStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	out := make([]AccountStatus, 0, len(p.accounts))
	for _, a := range p.accounts {
		until := p.coolingUntil[a.ID]
		_, bad := p.invalid[a.ID]
		state := StateActive
		var left time.Duration
		switch {
		case bad:
			state = StateInvalid
		case until.After(now):
			state = StateCooling
			left = until.Sub(now)
		}
		usage := 0
		if p.quota != nil {
			usage = p.quota.Usage(a.ID)
		}
		out = append(out, AccountStatus{
			ID:             a.ID,
			Name:           a.Name,
			Provider:       a.Provider,
			Priority:       a.Priority,
			UsesProxy:      a.ProxyEnabled(),
			ProxyMode:      a.ProxyModeEffective(),
			ProxyURL:       a.ProxyURL,
			State:          state,
			CooldownLeft:   left,
			Usage5h:        usage,
			QuotaLimit:     a.QuotaLimit,
			CooldownPeriod: time.Duration(a.CooldownPeriod) * time.Millisecond,
			BaseURL:        a.BaseURL,
			AvgLatencyMs:   p.latencyEma[a.ID],
			Inflight:       p.inflight[a.ID],
		})
	}
	return out
}
