package metrics

import (
	"testing"
	"time"

	"github.com/mcptears/opencode-max/db"
)

func newTestMetrics(t *testing.T) *Metrics {
	t.Helper()
	database, err := db.OpenMemory()
	if err != nil {
		t.Fatalf("open memory db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return New(database)
}

func TestCounters(t *testing.T) {
	m := newTestMetrics(t)
	m.Hit("a")
	m.Hit("a")
	m.Hit("b")
	m.Ok()
	m.Retried()
	m.AddTokensSaved(100)
	s := m.Summary()
	if s.Requests != 3 || s.Successes != 1 || s.Retries != 1 || s.TokensSaved != 100 {
		t.Fatalf("bad summary: %+v", s)
	}
	if s.PerAccount["a"] != 2 || s.PerAccount["b"] != 1 {
		t.Fatalf("bad perAccount: %+v", s.PerAccount)
	}
}

func TestRecordAndRecentEvents(t *testing.T) {
	m := newTestMetrics(t)
	m.Record(EventSettings, "port changed")
	m.Record(EventError, "boom")
	evs := m.RecentEvents(10)
	if len(evs) != 2 || evs[0].Kind != EventError || evs[1].Kind != EventSettings {
		t.Fatalf("events newest-first: %+v", evs)
	}
	// Restored from DB on restart.
	m2 := New(m.db)
	if evs2 := m2.RecentEvents(10); len(evs2) != 2 {
		t.Fatalf("restored events = %d, want 2", len(evs2))
	}
}

func TestLogRequestAndClearLogs(t *testing.T) {
	m := newTestMetrics(t)
	m.LogRequest("a", 200, 12.3, "qwen3.7-plus")
	m.LogRequest("a", 500, 5, "qwen3.7-plus")
	rows := m.RecentLogRequests(10)
	if len(rows) != 2 {
		t.Fatalf("log rows = %d, want 2", len(rows))
	}
	if rows[0].Status != 500 || rows[0].Model != "qwen3.7-plus" {
		t.Fatalf("newest-first row: %+v", rows[0])
	}
	m.ClearLogs()
	if rows := m.RecentLogRequests(10); len(rows) != 0 {
		t.Fatalf("after clear, log rows = %d, want 0 (cutoff hides them)", len(rows))
	}
	// History still sees the underlying data.
	if h := m.History(1); len(h) == 0 || h[0].Requests != 2 {
		t.Fatalf("history must survive clear: %+v", h)
	}
	// Cutoff persists across restarts.
	m2 := New(m.db)
	if rows := m2.RecentLogRequests(10); len(rows) != 0 {
		t.Fatalf("cutoff should persist, got %d rows", len(rows))
	}
}

func TestHistoryBuckets(t *testing.T) {
	m := newTestMetrics(t)
	m.LogRequest("a", 200, 1, "m1")
	m.LogRequest("a", 503, 1, "m1")
	m.Limited("a") // rate_limited event
	h := m.History(1)
	if len(h) != 1 {
		t.Fatalf("buckets = %d, want 1", len(h))
	}
	b := h[0]
	if b.Requests != 2 || b.Errors != 1 || b.RateLimited != 1 {
		t.Fatalf("bad bucket: %+v", b)
	}
}

func TestModelStatsAndProviderHealth(t *testing.T) {
	m := newTestMetrics(t)
	m.LogRequest("a1", 200, 100, "m1")
	m.LogRequest("a1", 500, 200, "m1")
	m.LogRequest("a2", 200, 50, "m2")
	providerOf := func(id string) string {
		if id == "a2" {
			return "p2"
		}
		return "p1"
	}
	stats := m.ModelStats(1, providerOf)
	if len(stats) != 2 {
		t.Fatalf("model stats = %d, want 2", len(stats))
	}
	if stats[0].Model != "m1" || stats[0].Requests != 2 || stats[0].Errors != 1 || stats[0].AvgLatencyMs != 150 {
		t.Fatalf("bad m1 stat: %+v", stats[0])
	}
	health := m.ProviderHealth(1, providerOf)
	if len(health) != 2 {
		t.Fatalf("provider health = %d, want 2", len(health))
	}
	if health[0].Provider != "p1" || health[0].Requests != 2 || health[0].SuccessRate != 50 {
		t.Fatalf("bad p1 health: %+v", health[0])
	}
	if health[0].LastErrorStatus == nil || *health[0].LastErrorStatus != 500 {
		t.Fatalf("p1 last error: %+v", health[0].LastErrorStatus)
	}
}

func TestLogUsageAndUsageStats(t *testing.T) {
	m := newTestMetrics(t)
	m.LogUsage("a", "m1", 100, 50)
	m.LogUsage("a", "m1", 200, 100)
	m.LogUsage("b", "m2", 10, 5)
	u := m.UsageStats(1)
	if len(u.ByAccount) != 2 || len(u.ByModel) != 2 {
		t.Fatalf("usage stats: %+v", u)
	}
	if u.ByAccount[0].AccountID != "a" || u.ByAccount[0].Total != 450 {
		t.Fatalf("bad account usage: %+v", u.ByAccount[0])
	}
	if u.ByModel[0].Model != "m1" || u.ByModel[0].Total != 450 {
		t.Fatalf("bad model usage: %+v", u.ByModel[0])
	}
}

func TestErrorRate(t *testing.T) {
	m := newTestMetrics(t)
	m.LogRequest("a", 200, 1, "m")
	m.LogRequest("a", 200, 1, "m")
	m.LogRequest("a", 500, 1, "m")
	r := m.ErrorRate(int64(time.Hour / time.Millisecond))
	if r.Requests != 3 || r.Errors != 1 || r.Rate != 1.0/3.0 {
		t.Fatalf("bad error rate: %+v", r)
	}
}

func TestNilDBNeverBreaks(t *testing.T) {
	m := New(nil)
	m.Record(EventError, "x")
	m.Hit("a")
	m.Ok()
	m.Limited("a")
	m.Rotated("lbl")
	m.Retried()
	m.Failover("p1", "p2")
	m.AddTokensSaved(5)
	m.LogRequest("a", 200, 1, "m")
	m.LogUsage("a", "m", 1, 1)
	m.ClearLogs()
	_ = m.History(1)
	_ = m.Summary()
	_ = m.RecentEvents(5)
	_ = m.ErrorRate(1000)
	_ = m.RecentRequests(5, nil)
	_ = m.ModelStats(1, nil)
	_ = m.ProviderHealth(1, nil)
	_ = m.UsageStats(1)
	if m.Summary().Requests != 1 {
		t.Fatal("in-memory counters must work without a DB")
	}
}
