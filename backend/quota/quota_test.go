package quota

import (
	"testing"
	"time"

	"github.com/mcptears/opencode-max/db"
)

func newTestTracker(t *testing.T, limit int) *Tracker {
	t.Helper()
	database, err := db.OpenMemory()
	if err != nil {
		t.Fatalf("open memory db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return New(database, limit)
}

func TestRecordAndUsage(t *testing.T) {
	q := newTestTracker(t, 100)
	if got := q.Usage("a", Window5HMs); got != 0 {
		t.Fatalf("initial usage = %d, want 0", got)
	}
	for i := 0; i < 7; i++ {
		q.Record("a")
	}
	if got := q.Usage("a", Window5HMs); got != 7 {
		t.Fatalf("usage = %d, want 7", got)
	}
	if got := q.Usage("b", Window5HMs); got != 0 {
		t.Fatalf("other account usage = %d, want 0", got)
	}
}

func TestUsageWindow(t *testing.T) {
	q := newTestTracker(t, 100)
	database := q.db
	// One recent event, one older than the 5h window.
	now := time.Now().UnixMilli()
	if _, err := database.Exec(`INSERT INTO usage_events (account_id, ts) VALUES (?, ?)`, "a", now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO usage_events (account_id, ts) VALUES (?, ?)`, "a", now-Window5HMs-1000); err != nil {
		t.Fatal(err)
	}
	if got := q.Usage("a", Window5HMs); got != 1 {
		t.Fatalf("usage in 5h window = %d, want 1", got)
	}
	if got := q.Usage("a", Window5HMs*2); got != 2 {
		t.Fatalf("usage in 10h window = %d, want 2", got)
	}
}

func TestLimitFor(t *testing.T) {
	q := newTestTracker(t, 100)
	if got := q.LimitFor(0); got != 100 {
		t.Fatalf("LimitFor(0) = %d, want 100", got)
	}
	if got := q.LimitFor(-5); got != 100 {
		t.Fatalf("LimitFor(-5) = %d, want 100", got)
	}
	if got := q.LimitFor(25); got != 25 {
		t.Fatalf("LimitFor(25) = %d, want 25", got)
	}
}

func TestIsOverAndNearQuota(t *testing.T) {
	q := newTestTracker(t, 100)
	for i := 0; i < 90; i++ {
		q.Record("a")
	}
	if q.IsOverQuota("a", 0) {
		t.Fatal("90/100 should not be over quota")
	}
	if !q.IsNearQuota("a", 0) {
		t.Fatal("90/100 should be near quota (>= 90%)")
	}
	for i := 0; i < 10; i++ {
		q.Record("a")
	}
	if !q.IsOverQuota("a", 0) {
		t.Fatal("100/100 should be over quota")
	}
	// Per-account override wins.
	if q.IsOverQuota("a", 200) {
		t.Fatal("100/200 should not be over quota with override")
	}
	if !q.IsNearQuota("a", 110) {
		t.Fatal("100/110 should be near quota with override")
	}
}

func TestPrune(t *testing.T) {
	q := newTestTracker(t, 100)
	now := time.Now().UnixMilli()
	old := now - 26*3600*1000 // older than the 25h retention
	if _, err := q.db.Exec(`INSERT INTO usage_events (account_id, ts) VALUES (?, ?)`, "a", old); err != nil {
		t.Fatal(err)
	}
	if _, err := q.db.Exec(`INSERT INTO usage_events (account_id, ts) VALUES (?, ?)`, "a", now); err != nil {
		t.Fatal(err)
	}
	q.Prune()
	var c int
	if err := q.db.QueryRow(`SELECT COUNT(*) FROM usage_events`).Scan(&c); err != nil {
		t.Fatal(err)
	}
	if c != 1 {
		t.Fatalf("rows after prune = %d, want 1", c)
	}
}

func TestNilDBNeverBreaks(t *testing.T) {
	q := New(nil, 100)
	q.Record("a") // must not panic
	q.Prune()     // must not panic
	if got := q.Usage("a", Window5HMs); got != 0 {
		t.Fatalf("nil-db usage = %d, want 0", got)
	}
	if q.IsOverQuota("a", 0) {
		t.Fatal("nil-db should never report over quota")
	}
}
