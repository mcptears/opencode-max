// Package quota implements per-account request counting over a rolling 5h
// window, persisted in SQLite. The pool steers *away* from accounts
// approaching their quota instead of waiting for a 429, and excludes
// accounts that already hit the limit until the window slides.
package quota

import (
	"database/sql"
	"time"

	"github.com/mcptears/opencode-max/zen"
)

// Window5HMs is the rolling quota window in milliseconds.
const Window5HMs int64 = 5 * 3600 * 1000

// retentionMs keeps a bit more than a day so the 5h window is always fully covered.
const retentionMs int64 = 25 * 3600 * 1000

// Tracker counts upstream requests per account in a trailing window.
type Tracker struct {
	db *sql.DB
	// GlobalLimit is the default 5h request cap applied to accounts that
	// have no per-account override.
	GlobalLimit int
}

// New returns a Tracker backed by db with the given global 5h limit.
func New(db *sql.DB, globalLimit int) *Tracker {
	return &Tracker{db: db, GlobalLimit: globalLimit}
}

// Record logs one upstream request against an account. It never fails:
// quota tracking must never break proxying.
func (q *Tracker) Record(accountID string) {
	q.RecordModel(accountID, "")
}

// RecordModel logs one upstream request against an account and model.
func (q *Tracker) RecordModel(accountID, model string) {
	if q.db == nil {
		return
	}
	_, _ = q.db.Exec(
		`INSERT INTO usage_events (account_id, ts, model) VALUES (?, ?, ?)`,
		accountID, time.Now().UnixMilli(), model,
	)
}

// RecordZenUsage stores the cost/allowance metadata Zen reports for a request.
func (q *Tracker) RecordZenUsage(accountID, model string, u zen.Usage) {
	if q.db == nil {
		return
	}
	_, _ = q.db.Exec(
		`INSERT INTO zen_usage (ts, account_id, model, allowance_usd, cost_usd, billing_source)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		time.Now().UnixMilli(), accountID, model, u.Allowance, u.Cost, u.BillingSource,
	)
}

// Allowance returns the allowance dollars counted against an account in the
// trailing window (Go reports usage this way).
func (q *Tracker) Allowance(accountID string, windowMs int64) float64 {
	if q.db == nil {
		return 0
	}
	if windowMs <= 0 {
		windowMs = Window5HMs
	}
	var sum sql.NullFloat64
	err := q.db.QueryRow(
		`SELECT SUM(allowance_usd) FROM zen_usage WHERE account_id = ? AND ts >= ?`,
		accountID, time.Now().UnixMilli()-windowMs,
	).Scan(&sum)
	if err != nil || !sum.Valid {
		return 0
	}
	return sum.Float64
}

// Usage returns the number of requests by this account in the trailing window.
func (q *Tracker) Usage(accountID string, windowMs int64) int {	if q.db == nil {
		return 0
	}
	if windowMs <= 0 {
		windowMs = Window5HMs
	}
	var c int
	err := q.db.QueryRow(
		`SELECT COUNT(*) FROM usage_events WHERE account_id = ? AND ts >= ?`,
		accountID, time.Now().UnixMilli()-windowMs,
	).Scan(&c)
	if err != nil {
		return 0
	}
	return c
}

// Usage5h returns requests by this account in the standard 5h window.
func (q *Tracker) Usage5h(accountID string) int {
	return q.Usage(accountID, Window5HMs)
}

// Limit returns the global 5h request limit.
func (q *Tracker) Limit() int {
	return q.GlobalLimit
}

// LimitFor returns the effective limit for an account: a positive
// per-account override wins over the global limit.
func (q *Tracker) LimitFor(accountQuotaLimit int) int {
	if accountQuotaLimit > 0 {
		return accountQuotaLimit
	}
	return q.GlobalLimit
}

// IsOverQuota reports whether the account has hit its 5h limit. A
// non-positive limit disables enforcement instead of blocking every request.
func (q *Tracker) IsOverQuota(accountID string, accountQuotaLimit int) bool {
	limit := q.LimitFor(accountQuotaLimit)
	if limit <= 0 {
		return false
	}
	return q.Usage(accountID, Window5HMs) >= limit
}

// IsNearQuota reports whether the account is at 90%+ of its 5h limit,
// so the pool can steer traffic away before a 429 happens. A non-positive
// limit disables enforcement.
func (q *Tracker) IsNearQuota(accountID string, accountQuotaLimit int) bool {
	limit := q.LimitFor(accountQuotaLimit)
	if limit <= 0 {
		return false
	}
	return q.Usage(accountID, Window5HMs) >= int(float64(limit)*0.9)
}

// Prune drops usage events older than the retention window. Called periodically.
func (q *Tracker) Prune() {
	if q.db == nil {
		return
	}
	_, _ = q.db.Exec(
		`DELETE FROM usage_events WHERE ts < ?`,
		time.Now().UnixMilli()-retentionMs,
	)
	_, _ = q.db.Exec(
		`DELETE FROM zen_usage WHERE ts < ?`,
		time.Now().UnixMilli()-retentionMs,
	)
}
