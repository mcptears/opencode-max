package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRedactProxy(t *testing.T) {
	got := RedactProxy("http://user:secret@proxy.example.com:8080")
	if got != "http://***@proxy.example.com:8080" {
		t.Fatalf("expected redacted URL, got %q", got)
	}
	if got := RedactProxy("http://proxy.example.com:8080"); got != "http://proxy.example.com:8080" {
		t.Fatalf("expected unchanged URL, got %q", got)
	}
}

func TestRoundRobin(t *testing.T) {
	r := New([]string{"http://p1:8080", "http://p2:8080", "http://p3:8080"})
	if got := r.Current(); got != "http://p1:8080" {
		t.Fatalf("expected p1 current, got %q", got)
	}
	seq := []string{r.Rotate(), r.Rotate(), r.Rotate(), r.Rotate()}
	want := []string{"http://p2:8080", "http://p3:8080", "http://p1:8080", "http://p2:8080"}
	for i := range want {
		if seq[i] != want[i] {
			t.Fatalf("rotation %d: expected %q, got %q", i, want[i], seq[i])
		}
	}
	if r.RotationsCount() != 4 {
		t.Fatalf("expected 4 rotations, got %d", r.RotationsCount())
	}
}

func TestDirectWhenNoProxies(t *testing.T) {
	r := New(nil)
	if got := r.Current(); got != "" {
		t.Fatalf("expected direct (empty), got %q", got)
	}
	if got := r.Rotate(); got != "" {
		t.Fatalf("expected direct (empty) on rotate, got %q", got)
	}
	if lbl := r.EgressLabel(); lbl != "direct (IPv4)" {
		t.Fatalf("expected direct label, got %q", lbl)
	}
}

func TestFamilyRotation(t *testing.T) {
	r := New(nil)
	r.ConfigureEgress(FamilyAuto, true)
	if r.CurrentFamily() != 4 {
		t.Fatalf("expected IPv4 first, got %d", r.CurrentFamily())
	}
	r.Rotate()
	if r.CurrentFamily() != 6 {
		t.Fatalf("expected IPv6 after rotate, got %d", r.CurrentFamily())
	}
	r.Rotate()
	if r.CurrentFamily() != 4 {
		t.Fatalf("expected IPv4 after second rotate, got %d", r.CurrentFamily())
	}
	r.ConfigureEgress(Family6, true)
	if r.CurrentFamily() != 6 {
		t.Fatalf("expected pinned IPv6, got %d", r.CurrentFamily())
	}
}

func TestUnhealthySkipped(t *testing.T) {
	// Unreachable proxy: connection refused is fast.
	bad := "http://127.0.0.1:1"
	good := "http://127.0.0.1:2"

	downCh := make(chan string, 4)
	r2 := New([]string{bad, good}, WithHealthChangeHook(func(p string, healthy bool) {
		if !healthy {
			downCh <- p
		}
	}))
	// Two consecutive failures mark it down.
	r2.CheckProxies([]string{bad}, "http://127.0.0.1:9/")
	r2.CheckProxies([]string{bad}, "http://127.0.0.1:9/")
	if r2.IsHealthy(bad) {
		t.Fatal("expected bad proxy to be unhealthy after 2 failures")
	}
	select {
	case p := <-downCh:
		if p != bad {
			t.Fatalf("expected hook for %q, got %q", bad, p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for onHealthChange(false)")
	}
	if got := r2.Current(); got != good {
		t.Fatalf("expected rotation to skip unhealthy proxy, current=%q", got)
	}
}

func TestHealthyServerPasses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	r := New([]string{"http://127.0.0.1:1"})
	r.CheckProxies([]string{"http://127.0.0.1:1"}, srv.URL)
	if !r.IsHealthy("http://127.0.0.1:1") {
		t.Fatal("single failure should not mark proxy unhealthy")
	}
}

func TestAutoDrop(t *testing.T) {
	r := New(
		[]string{"http://p1:8080", "http://p2:8080"},
		WithAutoDropFails(2),
	)
	var dropped string
	droppedCh := make(chan string, 1)
	r2 := New(
		[]string{"http://p1:8080", "http://p2:8080"},
		WithAutoDropFails(2),
		WithProxyDroppedHook(func(p string, n int) { droppedCh <- p }),
	)
	_ = r
	r2.RecordProxyResult("http://p1:8080", false, 0)
	if r2.Count() != 2 {
		t.Fatal("should not drop before threshold")
	}
	r2.RecordProxyResult("http://p1:8080", false, 0)
	select {
	case dropped = <-droppedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for drop hook")
	}
	if r2.Count() != 1 {
		t.Fatalf("expected p1 auto-dropped, count=%d", r2.Count())
	}
	if dropped != "http://p1:8080" {
		t.Fatalf("expected drop hook for p1, got %q", dropped)
	}
	// Last proxy standing is never dropped.
	r2.RecordProxyResult("http://p2:8080", false, 0)
	r2.RecordProxyResult("http://p2:8080", false, 0)
	if r2.Count() != 1 {
		t.Fatal("last proxy must not be auto-dropped")
	}
}

func TestRecordProxyResultQuality(t *testing.T) {
	r := New([]string{"http://p1:8080"})
	r.RecordProxyResult("http://p1:8080", true, 200)
	r.RecordProxyResult("http://p1:8080", true, 100)
	q := r.QualityOf("http://p1:8080")
	if q == nil || q.Ok != 2 {
		t.Fatalf("expected 2 ok, got %+v", q)
	}
	// EMA: 200 then 0.7*200+0.3*100 = 170
	if q.LatencyEma != 170 {
		t.Fatalf("expected latency EMA 170, got %d", q.LatencyEma)
	}
}

func TestSetProxies(t *testing.T) {
	r := New([]string{"http://p1:8080", "http://p2:8080"})
	r.Rotate()
	r.SetProxies([]string{"http://p9:8080"})
	if r.Count() != 1 || r.Current() != "http://p9:8080" {
		t.Fatalf("expected single p9, got count=%d current=%q", r.Count(), r.Current())
	}
}

func TestTransport(t *testing.T) {
	r := New(nil)
	tr := r.Transport("http://user:pw@proxy.example.com:8080")
	if tr.Proxy == nil {
		t.Fatal("expected Proxy set for http proxy URL")
	}
	req, _ := http.NewRequest("GET", "http://example.com/", nil)
	pu, err := tr.Proxy(req)
	if err != nil || pu.Host != "proxy.example.com:8080" {
		t.Fatalf("expected proxy host, got %v %v", pu, err)
	}
	tr2 := r.Transport("")
	if tr2.Proxy != nil {
		t.Fatal("direct transport must not set Proxy")
	}
}

func TestStatus(t *testing.T) {
	r := New([]string{"http://u:p@h:1"})
	st := r.Status()
	if st.Proxies != 1 || st.Current != "http://u:p@h:1" {
		t.Fatalf("unexpected status %+v", st)
	}
	if len(st.Health) != 1 || st.Health[0].Proxy != "http://***@h:1" {
		t.Fatalf("expected redacted health entry, got %+v", st.Health)
	}
	if !st.Health[0].Healthy {
		t.Fatal("unknown proxy should default to healthy")
	}
}
