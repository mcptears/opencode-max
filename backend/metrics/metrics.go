// Package metrics records request counters, the system event feed and the
// request log. Hot counters live in memory; events and request history are
// persisted in SQLite (see the db package).
package metrics

import (
	"database/sql"
	"sort"
	"strconv"
	"sync"
	"time"
)

// EventKind classifies a system event in the Logs feed.
type EventKind string

const (
	EventRequest        EventKind = "request"
	EventRateLimited    EventKind = "rate_limited"
	EventRotated        EventKind = "rotated"
	EventAccountAdded   EventKind = "account_added"
	EventAccountRemoved EventKind = "account_removed"
	EventProxyAdded     EventKind = "proxy_added"
	EventProxyRemoved   EventKind = "proxy_removed"
	EventSettings       EventKind = "settings"
	EventFailover       EventKind = "failover"
	EventError          EventKind = "error"
)

// MetricEvent is one row of the Logs feed.
type MetricEvent struct {
	T      int64     `json:"t"`
	Kind   EventKind `json:"kind"`
	Detail string    `json:"detail"`
}

// HistoryBucket aggregates one hour of request/event history for the chart.
type HistoryBucket struct {
	Hour        int64 `json:"hour"`
	Requests    int   `json:"requests"`
	Errors      int   `json:"errors"`
	RateLimited int   `json:"rateLimited"`
	Rotations   int   `json:"rotations"`
}

// RequestLogRow is one completed proxied request from request_log.
type RequestLogRow struct {
	T         int64  `json:"t"`
	AccountID string `json:"accountId"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Status    int    `json:"status"`
	LatencyMs int    `json:"latencyMs"`
}

// ModelStat aggregates per-model usage over a window.
type ModelStat struct {
	Model        string `json:"model"`
	Provider     string `json:"provider"`
	Requests     int    `json:"requests"`
	Errors       int    `json:"errors"`
	AvgLatencyMs int    `json:"avgLatencyMs"`
}

// ProviderHealth describes per-provider health over a window.
type ProviderHealth struct {
	Provider        string  `json:"provider"`
	Requests        int     `json:"requests"`
	Errors          int     `json:"errors"`
	SuccessRate     float64 `json:"successRate"`
	AvgLatencyMs    int     `json:"avgLatencyMs"`
	LastErrorStatus *int    `json:"lastErrorStatus"`
	LastErrorAt     *int64  `json:"lastErrorAt"`
}

// UsageTotals aggregates token counts over a window.
type UsageTotals struct {
	ByAccount []AccountUsage `json:"byAccount"`
	ByModel   []ModelUsage   `json:"byModel"`
}

// AccountUsage is token usage for one account.
type AccountUsage struct {
	AccountID  string `json:"accountId"`
	Prompt     int64  `json:"prompt"`
	Completion int64  `json:"completion"`
	Total      int64  `json:"total"`
	Requests   int    `json:"requests"`
}

// ModelUsage is token usage for one model.
type ModelUsage struct {
	Model      string `json:"model"`
	Prompt     int64  `json:"prompt"`
	Completion int64  `json:"completion"`
	Total      int64  `json:"total"`
	Requests   int    `json:"requests"`
}

// Summary is the /api/metrics summary payload.
type Summary struct {
	UptimeSec   int64            `json:"uptimeSec"`
	Requests    int64            `json:"requests"`
	Successes   int64            `json:"successes"`
	RateLimited int64            `json:"rateLimited"`
	Rotations   int64            `json:"rotations"`
	Retries     int64            `json:"retries"`
	Failovers   int64            `json:"failovers"`
	TokensSaved int64            `json:"tokensSaved"`
	PerAccount  map[string]int64 `json:"perAccount"`
}

// ErrorRateResult is the error rate over a trailing window.
type ErrorRateResult struct {
	Requests int     `json:"requests"`
	Errors   int     `json:"errors"`
	Rate     float64 `json:"rate"`
}

// ProviderOf maps an account id to its provider id for dashboard enrichment.
type ProviderOf func(accountID string) string

const maxEvents = 200

// historyRetentionMs keeps 30 days of history; pruned on startup.
const historyRetentionMs int64 = 30 * 24 * 3600 * 1000

// Metrics is the recorder. Hot counters are guarded by mu; events and the
// request log are persisted in SQLite.
type Metrics struct {
	mu          sync.Mutex
	db          *sql.DB
	startedAt   int64
	requests    int64
	successes   int64
	rateLimited int64
	rotations   int64
	retries     int64
	failovers   int64
	tokensSaved int64
	perAccount  map[string]int64
	events      []MetricEvent
	// logsCutoff hides Logs-feed entries at/before this ts (Clear logs keeps
	// graphs and usage history intact).
	logsCutoff int64
}

// New creates a Metrics recorder, restoring recent events and the logs
// cutoff from the database and pruning history older than 30 days.
func New(db *sql.DB) *Metrics {
	m := &Metrics{
		db:         db,
		startedAt:  time.Now().UnixMilli(),
		perAccount: map[string]int64{},
	}
	if db == nil {
		return m
	}
	_, _ = db.Exec(`CREATE TABLE IF NOT EXISTS kv_store (k TEXT PRIMARY KEY, v TEXT)`)
	var cutoff string
	if err := db.QueryRow(`SELECT v FROM kv_store WHERE k = 'logs_cutoff'`).Scan(&cutoff); err == nil {
		if n, err := strconv.ParseInt(cutoff, 10, 64); err == nil {
			m.logsCutoff = n
		}
	}
	rows, err := db.Query(`SELECT ts, kind, detail FROM metric_events ORDER BY id DESC LIMIT ?`, maxEvents)
	if err == nil {
		defer rows.Close()
		// Rows arrive newest-first, matching the in-memory order (events[0] is newest).
		for rows.Next() {
			var e MetricEvent
			var kind string
			if err := rows.Scan(&e.T, &kind, &e.Detail); err == nil {
				e.Kind = EventKind(kind)
				m.events = append(m.events, e)
			}
		}
	}
	cutoffTs := time.Now().UnixMilli() - historyRetentionMs
	_, _ = db.Exec(`DELETE FROM metric_events WHERE ts < ?`, cutoffTs)
	_, _ = db.Exec(`DELETE FROM request_log WHERE ts < ?`, cutoffTs)
	return m
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}

// Record appends a system event to the feed (and persists it).
func (m *Metrics) Record(kind EventKind, detail string) {
	ev := MetricEvent{T: time.Now().UnixMilli(), Kind: kind, Detail: detail}
	m.mu.Lock()
	m.events = append([]MetricEvent{ev}, m.events...)
	if len(m.events) > maxEvents {
		m.events = m.events[:maxEvents]
	}
	m.mu.Unlock()
	if m.db != nil {
		_, _ = m.db.Exec(
			`INSERT INTO metric_events (ts, kind, detail) VALUES (?, ?, ?)`,
			ev.T, string(kind), detail,
		)
	}
}

// Hit counts one proxied request against an account.
func (m *Metrics) Hit(accountID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests++
	m.perAccount[accountID]++
}

// Ok counts a request that reached upstream without a retryable error.
func (m *Metrics) Ok() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.successes++
}

// Limited parks a rate-limited account and records the event.
func (m *Metrics) Limited(accountID string) {
	m.mu.Lock()
	m.rateLimited++
	m.mu.Unlock()
	m.Record(EventRateLimited, "429/quota on "+accountID+" — token parked, IP rotated")
}

// Rotated records an egress IP rotation.
func (m *Metrics) Rotated(label string) {
	m.mu.Lock()
	m.rotations++
	m.mu.Unlock()
	m.Record(EventRotated, "egress rotated → "+label)
}

// Retried counts a transparent upstream retry.
func (m *Metrics) Retried() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.retries++
}

// Failover records a provider failover.
func (m *Metrics) Failover(from, to string) {
	m.mu.Lock()
	m.failovers++
	m.mu.Unlock()
	m.Record(EventFailover, "provider failover: "+from+" → "+to)
}

// AddTokensSaved accumulates estimated tokens saved by the token saver
// (chars/4 heuristic).
func (m *Metrics) AddTokensSaved(n int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tokensSaved += n
}

// LogRequest logs one completed proxied request (called once per forward).
func (m *Metrics) LogRequest(accountID string, status int, latencyMs float64, model string) {
	if m.db == nil {
		return
	}
	var modelVal any
	if model != "" {
		modelVal = model
	}
	_, _ = m.db.Exec(
		`INSERT INTO request_log (ts, account_id, status, latency_ms, model) VALUES (?, ?, ?, ?, ?)`,
		time.Now().UnixMilli(), accountID, status, int64(latencyMs+0.5), modelVal,
	)
}

// History returns hourly buckets for the last N hours (dashboard chart).
func (m *Metrics) History(hours int) []HistoryBucket {
	if hours <= 0 {
		hours = 24
	}
	since := time.Now().UnixMilli() - int64(hours)*3600*1000
	buckets := map[int64]*HistoryBucket{}
	bucket := func(ts int64) *HistoryBucket {
		hour := ts / 3600000 * 3600000
		b, ok := buckets[hour]
		if !ok {
			b = &HistoryBucket{Hour: hour}
			buckets[hour] = b
		}
		return b
	}
	if m.db != nil {
		rows, err := m.db.Query(`SELECT ts, status FROM request_log WHERE ts >= ?`, since)
		if err == nil {
			for rows.Next() {
				var ts int64
				var status int
				if err := rows.Scan(&ts, &status); err == nil {
					b := bucket(ts)
					b.Requests++
					if status >= 500 || status == 0 {
						b.Errors++
					}
				}
			}
			rows.Close()
		}
		rows, err = m.db.Query(
			`SELECT ts, kind FROM metric_events WHERE ts >= ? AND kind IN ('rate_limited','rotated')`, since)
		if err == nil {
			for rows.Next() {
				var ts int64
				var kind string
				if err := rows.Scan(&ts, &kind); err == nil {
					b := bucket(ts)
					if kind == "rate_limited" {
						b.RateLimited++
					} else {
						b.Rotations++
					}
				}
			}
			rows.Close()
		}
	}
	out := make([]HistoryBucket, 0, len(buckets))
	for _, b := range buckets {
		out = append(out, *b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Hour < out[j].Hour })
	return out
}

// Summary returns the aggregate counters.
func (m *Metrics) Summary() Summary {
	m.mu.Lock()
	defer m.mu.Unlock()
	perAccount := make(map[string]int64, len(m.perAccount))
	for k, v := range m.perAccount {
		perAccount[k] = v
	}
	return Summary{
		UptimeSec:   (time.Now().UnixMilli() - m.startedAt) / 1000,
		Requests:    m.requests,
		Successes:   m.successes,
		RateLimited: m.rateLimited,
		Rotations:   m.rotations,
		Retries:     m.retries,
		Failovers:   m.failovers,
		TokensSaved: m.tokensSaved,
		PerAccount:  perAccount,
	}
}

// RecentEvents returns the newest events first.
func (m *Metrics) RecentEvents(limit int) []MetricEvent {
	if limit <= 0 {
		limit = 50
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit > len(m.events) {
		limit = len(m.events)
	}
	out := make([]MetricEvent, limit)
	copy(out, m.events[:limit])
	return out
}

// RecentLogRequests returns recent request log rows, newest first,
// hiding entries at/before the clear cutoff.
func (m *Metrics) RecentLogRequests(limit int) []RequestLogRow {
	if limit <= 0 {
		limit = 100
	}
	if m.db == nil {
		return nil
	}
	rows, err := m.db.Query(
		`SELECT ts, account_id, status, latency_ms, model FROM request_log WHERE ts > ? ORDER BY ts DESC LIMIT ?`,
		m.logsCutoff, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []RequestLogRow
	for rows.Next() {
		var r RequestLogRow
		var model sql.NullString
		if err := rows.Scan(&r.T, &r.AccountID, &r.Status, &r.LatencyMs, &model); err == nil {
			r.Model = model.String
			out = append(out, r)
		}
	}
	return out
}

// ClearLogs clears the Logs-tab feed only — graphs and usage history stay
// intact. A persistent cutoff timestamp hides older entries.
func (m *Metrics) ClearLogs() {
	m.mu.Lock()
	m.events = nil
	m.logsCutoff = time.Now().UnixMilli()
	cutoff := m.logsCutoff
	m.mu.Unlock()
	if m.db == nil {
		return
	}
	_, _ = m.db.Exec(`DELETE FROM metric_events`)
	_, _ = m.db.Exec(`INSERT OR REPLACE INTO kv_store (k, v) VALUES ('logs_cutoff', ?)`, itoa(cutoff))
}

// ErrorRate returns the error rate over a trailing window (for spike alerts).
func (m *Metrics) ErrorRate(windowMs int64) ErrorRateResult {
	if m.db == nil {
		return ErrorRateResult{}
	}
	var requests, errors int
	err := m.db.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END), 0)
		 FROM request_log WHERE ts > ?`,
		time.Now().UnixMilli()-windowMs,
	).Scan(&requests, &errors)
	if err != nil {
		return ErrorRateResult{}
	}
	rate := 0.0
	if requests > 0 {
		rate = float64(errors) / float64(requests)
	}
	return ErrorRateResult{Requests: requests, Errors: errors, Rate: rate}
}

// RecentRequests returns the latest proxied requests, newest first.
func (m *Metrics) RecentRequests(limit int, providerOf ProviderOf) []RequestLogRow {
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	if m.db == nil {
		return nil
	}
	rows, err := m.db.Query(
		`SELECT ts, account_id, model, status, latency_ms FROM request_log ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []RequestLogRow
	for rows.Next() {
		var r RequestLogRow
		var model sql.NullString
		if err := rows.Scan(&r.T, &r.AccountID, &model, &r.Status, &r.LatencyMs); err == nil {
			r.Model = model.String
			if providerOf != nil {
				r.Provider = providerOf(r.AccountID)
			}
			if r.Provider == "" {
				r.Provider = "unknown"
			}
			out = append(out, r)
		}
	}
	return out
}

// ModelStats returns per-model usage over the last N hours: requests,
// errors, average latency.
func (m *Metrics) ModelStats(hours int, providerOf ProviderOf) []ModelStat {
	if hours <= 0 {
		hours = 24
	}
	if m.db == nil {
		return nil
	}
	since := time.Now().UnixMilli() - int64(hours)*3600*1000
	rows, err := m.db.Query(`
		SELECT model, account_id, COUNT(*),
		       COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0),
		       COALESCE(AVG(latency_ms), 0)
		FROM request_log WHERE ts > ? AND model IS NOT NULL
		GROUP BY model, account_id ORDER BY COUNT(*) DESC LIMIT 100`, since)
	if err != nil {
		return nil
	}
	defer rows.Close()
	type agg struct {
		requests  int
		errors    int
		latSum    float64
		providers map[string]int
	}
	byModel := map[string]*agg{}
	for rows.Next() {
		var model, accountID string
		var requests, errors int
		var avgLat float64
		if err := rows.Scan(&model, &accountID, &requests, &errors, &avgLat); err != nil {
			continue
		}
		a, ok := byModel[model]
		if !ok {
			a = &agg{providers: map[string]int{}}
			byModel[model] = a
		}
		a.requests += requests
		a.errors += errors
		a.latSum += avgLat * float64(requests)
		p := "unknown"
		if providerOf != nil {
			if v := providerOf(accountID); v != "" {
				p = v
			}
		}
		a.providers[p] += requests
	}
	out := make([]ModelStat, 0, len(byModel))
	for model, a := range byModel {
		top, topN := "unknown", -1
		for p, n := range a.providers {
			if n > topN {
				top, topN = p, n
			}
		}
		avg := 0
		if a.requests > 0 {
			avg = int(a.latSum/float64(a.requests) + 0.5)
		}
		out = append(out, ModelStat{Model: model, Provider: top, Requests: a.requests, Errors: a.errors, AvgLatencyMs: avg})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Requests > out[j].Requests })
	return out
}

// LogUsage records token usage reported by an upstream response for one request.
func (m *Metrics) LogUsage(accountID, model string, prompt, completion int64) {
	if m.db == nil {
		return
	}
	if prompt < 0 {
		prompt = 0
	}
	if completion < 0 {
		completion = 0
	}
	var modelVal any
	if model != "" {
		modelVal = model
	}
	_, _ = m.db.Exec(
		`INSERT INTO token_usage (ts, account_id, model, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, ?)`,
		time.Now().UnixMilli(), accountID, modelVal, prompt, completion,
	)
}

// ProviderHealth returns per-provider health over the last N hours:
// volume, success rate, latency, last error.
func (m *Metrics) ProviderHealth(hours int, providerOf ProviderOf) []ProviderHealth {
	if hours <= 0 {
		hours = 24
	}
	if m.db == nil {
		return nil
	}
	since := time.Now().UnixMilli() - int64(hours)*3600*1000
	rows, err := m.db.Query(
		`SELECT account_id, status, latency_ms, ts FROM request_log WHERE ts > ? ORDER BY ts DESC LIMIT 20000`, since)
	if err != nil {
		return nil
	}
	defer rows.Close()
	type agg struct {
		requests        int
		errors          int
		latSum          int64
		lastErrorStatus *int
		lastErrorAt     *int64
	}
	byProvider := map[string]*agg{}
	for rows.Next() {
		var accountID string
		var status int
		var latencyMs int64
		var ts int64
		if err := rows.Scan(&accountID, &status, &latencyMs, &ts); err != nil {
			continue
		}
		p := "unknown"
		if providerOf != nil {
			if v := providerOf(accountID); v != "" {
				p = v
			}
		}
		a, ok := byProvider[p]
		if !ok {
			a = &agg{}
			byProvider[p] = a
		}
		a.requests++
		a.latSum += latencyMs
		if status >= 400 {
			a.errors++
			// Rows are newest-first, so the first error seen is the most recent.
			if a.lastErrorAt == nil {
				s, t := status, ts
				a.lastErrorStatus = &s
				a.lastErrorAt = &t
			}
		}
	}
	out := make([]ProviderHealth, 0, len(byProvider))
	for provider, a := range byProvider {
		rate := 100.0
		if a.requests > 0 {
			rate = float64(a.requests-a.errors) / float64(a.requests) * 100
			rate = float64(int(rate*10+0.5)) / 10
		}
		avg := 0
		if a.requests > 0 {
			avg = int(float64(a.latSum)/float64(a.requests) + 0.5)
		}
		out = append(out, ProviderHealth{
			Provider: provider, Requests: a.requests, Errors: a.errors,
			SuccessRate: rate, AvgLatencyMs: avg,
			LastErrorStatus: a.lastErrorStatus, LastErrorAt: a.lastErrorAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Requests > out[j].Requests })
	return out
}

// UsageStats returns token totals over the last N hours, per account and per model.
func (m *Metrics) UsageStats(hours int) UsageTotals {
	empty := UsageTotals{}
	if hours <= 0 {
		hours = 24
	}
	if m.db == nil {
		return empty
	}
	since := time.Now().UnixMilli() - int64(hours)*3600*1000
	rows, err := m.db.Query(`
		SELECT account_id, COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COUNT(*)
		FROM token_usage WHERE ts > ? GROUP BY account_id ORDER BY SUM(prompt_tokens) DESC`, since)
	if err != nil {
		return empty
	}
	for rows.Next() {
		var u AccountUsage
		if err := rows.Scan(&u.AccountID, &u.Prompt, &u.Completion, &u.Requests); err == nil {
			u.Total = u.Prompt + u.Completion
			empty.ByAccount = append(empty.ByAccount, u)
		}
	}
	rows.Close()
	rows, err = m.db.Query(`
		SELECT model, COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COUNT(*)
		FROM token_usage WHERE ts > ? AND model IS NOT NULL
		GROUP BY model ORDER BY SUM(prompt_tokens) DESC LIMIT 50`, since)
	if err != nil {
		return empty
	}
	defer rows.Close()
	for rows.Next() {
		var u ModelUsage
		if err := rows.Scan(&u.Model, &u.Prompt, &u.Completion, &u.Requests); err == nil {
			u.Total = u.Prompt + u.Completion
			empty.ByModel = append(empty.ByModel, u)
		}
	}
	return empty
}
