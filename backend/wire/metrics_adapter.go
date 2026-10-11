package wire

import (
	"github.com/mcptears/opencode-max/metrics"
)

// ---------------------------------------------------------------------------
// MetricsAdapter: *metrics.Metrics -> api.Metrics
// ---------------------------------------------------------------------------

type MetricsAdapter struct {
	M *metrics.Metrics
}

func (a *MetricsAdapter) Summary() any { return a.M.Summary() }

func (a *MetricsAdapter) RecentEvents(n int) []any {
	events := a.M.RecentEvents(n)
	out := make([]any, len(events))
	for i, e := range events {
		out[i] = e
	}
	return out
}

func (a *MetricsAdapter) RecentLogRequests(n int) []any {
	rows := a.M.RecentLogRequests(n)
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = r
	}
	return out
}

func (a *MetricsAdapter) ClearLogs() { a.M.ClearLogs() }

func (a *MetricsAdapter) History(hours int) any { return a.M.History(hours) }

func (a *MetricsAdapter) ModelStats(hours int, providerOf func(string) string) any {
	return a.M.ModelStats(hours, metrics.ProviderOf(providerOf))
}

func (a *MetricsAdapter) UsageStats(hours int) any { return a.M.UsageStats(hours) }

func (a *MetricsAdapter) ProviderHealth(hours int, providerOf func(string) string) any {
	return a.M.ProviderHealth(hours, metrics.ProviderOf(providerOf))
}

func (a *MetricsAdapter) RecentRequests(n int, providerOf func(string) string) []any {
	rows := a.M.RecentRequests(n, metrics.ProviderOf(providerOf))
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = r
	}
	return out
}

func (a *MetricsAdapter) Record(event, message string) {
	a.M.Record(metrics.EventKind(event), message)
}

func (a *MetricsAdapter) Rotated(label string) { a.M.Rotated(label) }

func (a *MetricsAdapter) Limited(accountID string) { a.M.Limited(accountID) }

func (a *MetricsAdapter) Retried() { a.M.Retried() }

func (a *MetricsAdapter) Failover(from, to string) { a.M.Failover(from, to) }

func (a *MetricsAdapter) Hit(accountID string) { a.M.Hit(accountID) }

func (a *MetricsAdapter) Ok() { a.M.Ok() }

func (a *MetricsAdapter) AddTokensSaved(n int) { a.M.AddTokensSaved(int64(n)) }

func (a *MetricsAdapter) LogRequest(accountID string, status int, latencyMs int64, model string) {
	a.M.LogRequest(accountID, status, float64(latencyMs), model)
}

func (a *MetricsAdapter) LogUsage(accountID, model string, prompt, completion int) {
	a.M.LogUsage(accountID, model, int64(prompt), int64(completion))
}

func (a *MetricsAdapter) Prometheus() string {
	// The prometheus package renders this; wire it in main if needed.
	return ""
}

func (a *MetricsAdapter) RecordLatency(id string, ms int64) {
	// Latency EMA lives in the pool; metrics records it via LogRequest.
}
