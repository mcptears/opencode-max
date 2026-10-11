// Package wire bridges the real backend implementations to the api
// package's placeholder interfaces, plus the upstream forwarding client.
package wire

import (
	"time"

	"github.com/mcptears/opencode-max/api"
	"github.com/mcptears/opencode-max/pool"
	"github.com/mcptears/opencode-max/types"
)

// ---------------------------------------------------------------------------
// AccountConfig conversions
// ---------------------------------------------------------------------------

func toAPIAccount(a types.AccountConfig) api.AccountConfig {
	out := api.AccountConfig{
		ID:       a.ID,
		Name:     a.Name,
		Provider: a.Provider,
		APIKey:   a.APIKey,
		Priority: a.Priority,
	}
	if a.Cookies != "" {
		out.Cookies = &a.Cookies
	}
	out.UseProxy = a.UseProxy
	if a.CooldownPeriod != 0 {
		out.CooldownPeriod = &a.CooldownPeriod
	}
	if a.BaseURL != "" {
		out.BaseURL = &a.BaseURL
	}
	if a.QuotaLimit != 0 {
		out.QuotaLimit = &a.QuotaLimit
	}
	return out
}

func fromAPIAccount(a api.AccountConfig) types.AccountConfig {
	out := types.AccountConfig{
		ID:       a.ID,
		Name:     a.Name,
		Provider: a.Provider,
		APIKey:   a.APIKey,
		Priority: a.Priority,
		UseProxy: a.UseProxy,
	}
	if a.Cookies != nil {
		out.Cookies = *a.Cookies
	}
	if a.CooldownPeriod != nil {
		out.CooldownPeriod = *a.CooldownPeriod
	}
	if a.BaseURL != nil {
		out.BaseURL = *a.BaseURL
	}
	if a.QuotaLimit != nil {
		out.QuotaLimit = *a.QuotaLimit
	}
	return out
}

// ---------------------------------------------------------------------------
// PoolAdapter: *pool.Pool -> api.AccountPool
// ---------------------------------------------------------------------------

type PoolAdapter struct {
	P *pool.Pool
	// DefaultCooldown is used when api.MarkLimited is called without a duration.
	DefaultCooldown time.Duration
}

func (a *PoolAdapter) Status() []api.AccountStatus {
	states := a.P.Status()
	out := make([]api.AccountStatus, len(states))
	for i, s := range states {
		out[i] = api.AccountStatus{
			ID:             s.ID,
			Name:           s.Name,
			Provider:       s.Provider,
			Priority:       s.Priority,
			UseProxy:       boolPtr(s.UsesProxy),
			State:          string(s.State),
			CooldownEndsIn: s.CooldownLeft.Milliseconds(),
			Usage5h:        s.Usage5h,
			AvgLatencyMs:   float64(s.AvgLatencyMs),
		}
		if s.QuotaLimit != 0 {
			out[i].QuotaLimit = &s.QuotaLimit
		}
		if s.CooldownPeriod != 0 {
			ms := s.CooldownPeriod.Milliseconds()
			out[i].CooldownPeriod = &ms
		}
		if s.BaseURL != "" {
			out[i].BaseURL = &s.BaseURL
		}
	}
	return out
}

func (a *PoolAdapter) Acquire(providerID string) *api.AccountConfig {
	ac := a.P.Acquire(providerID)
	if ac == nil {
		return nil
	}
	out := toAPIAccount(*ac)
	return &out
}

func (a *PoolAdapter) Release(id string) { a.P.Release(id) }

func (a *PoolAdapter) Replace(accounts []api.AccountConfig) {
	out := make([]types.AccountConfig, len(accounts))
	for i, ac := range accounts {
		out[i] = fromAPIAccount(ac)
	}
	a.P.Replace(out)
}

func (a *PoolAdapter) ClearInvalid(id string) { a.P.ResetAccount(id) }

func (a *PoolAdapter) Count(providerID string) int { return a.P.Count(providerID) }

func (a *PoolAdapter) AllInvalid(providerID string) bool { return a.P.AllInvalid(providerID) }

func (a *PoolAdapter) NextAvailableIn(providerID string) int64 {
	return a.P.NextAvailableIn(providerID).Milliseconds()
}

func (a *PoolAdapter) AtCap(providerID string) bool { return a.P.AtCap(providerID) }

func (a *PoolAdapter) HasCapacity(providerID string) bool { return a.P.HasCapacity(providerID) }

func (a *PoolAdapter) MarkInvalid(id string) { a.P.MarkInvalid(id) }

func (a *PoolAdapter) MarkLimited(id string) { a.P.MarkLimited(id, a.DefaultCooldown) }

func (a *PoolAdapter) RecordLatency(id string, ms int64) { a.P.RecordLatency(id, ms) }

func boolPtr(b bool) *bool { return &b }
