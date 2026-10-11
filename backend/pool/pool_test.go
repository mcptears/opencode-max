package pool

import (
	"sync"
	"testing"
	"time"
)

func boolPtr(b bool) *bool { return &b }

func testAccounts() []AccountConfig {
	return []AccountConfig{
		{ID: "a1", Name: "one", Provider: "zen", APIKey: "k1", Priority: 1},
		{ID: "a2", Name: "two", Provider: "zen", APIKey: "k2", Priority: 2},
		{ID: "a3", Name: "three", Provider: "qwen", APIKey: "k3", Priority: 1},
	}
}

func TestAcquirePriorityOrder(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute})
	got := p.Acquire("zen")
	if got == nil || got.ID != "a1" {
		t.Fatalf("expected a1 (priority 1), got %+v", got)
	}
	p.Release(got.ID)
}

func TestAcquireSkipsCoolingDown(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute})
	p.MarkLimited("a1", time.Minute)
	got := p.Acquire("zen")
	if got == nil || got.ID != "a2" {
		t.Fatalf("expected a2 after a1 parked, got %+v", got)
	}
	p.Release(got.ID)
}

func TestAcquireSkipsInvalid(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute})
	p.MarkInvalid("a1")
	p.MarkInvalid("a2")
	if got := p.Acquire("zen"); got != nil {
		t.Fatalf("expected nil when all invalid, got %s", got.ID)
	}
	if !p.AllInvalid("zen") {
		t.Fatal("expected AllInvalid(zen) to be true")
	}
}

func TestCooldownExpiryRejoinsPool(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute})
	p.MarkLimited("a1", 30*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	got := p.Acquire("zen")
	if got == nil || got.ID != "a1" {
		t.Fatalf("expected a1 after cooldown expired, got %+v", got)
	}
	p.Release(got.ID)
}

func TestMarkLimitedDefaultCooldown(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: 5 * time.Minute})
	p.MarkLimited("a1", 0) // no override -> default
	if wait := p.NextAvailableIn("zen"); wait <= 4*time.Minute || wait > 5*time.Minute {
		t.Fatalf("expected ~5m cooldown, got %v", wait)
	}
}

func TestMarkLimitedAccountOverride(t *testing.T) {
	accs := testAccounts()
	accs[0].CooldownPeriod = int64(42 * time.Second / time.Millisecond)
	p := New(accs, Options{DefaultCooldownMs: 5 * time.Minute})
	p.MarkLimited("a1", 0)
	if wait := p.NextAvailableIn("zen"); wait <= 30*time.Second || wait > 42*time.Second {
		t.Fatalf("expected ~42s per-account cooldown, got %v", wait)
	}
}

func TestResetAccount(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute})
	p.MarkInvalid("a1")
	p.MarkLimited("a2", time.Minute)
	p.ResetAccount("a1")
	p.ResetAccount("a2")
	if p.IsInvalid("a1") {
		t.Fatal("a1 should not be invalid after reset")
	}
	got := p.Acquire("zen")
	if got == nil || got.ID != "a1" {
		t.Fatalf("expected a1 usable after reset, got %+v", got)
	}
	p.Release(got.ID)
}

func TestProviderFilter(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute})
	got := p.Acquire("qwen")
	if got == nil || got.ID != "a3" {
		t.Fatalf("expected a3 for qwen provider, got %+v", got)
	}
	p.Release(got.ID)
	if n := p.Count("qwen"); n != 1 {
		t.Fatalf("expected 1 qwen account, got %d", n)
	}
}

func TestConcurrencyCap(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute, AccountConcurrency: 1})
	first := p.Acquire("zen")
	if first == nil || first.ID != "a1" {
		t.Fatalf("expected a1 first, got %+v", first)
	}
	second := p.Acquire("zen")
	if second == nil || second.ID != "a2" {
		t.Fatalf("expected a2 (a1 at cap), got %+v", second)
	}
	third := p.Acquire("zen")
	if third != nil {
		t.Fatalf("expected nil when both at cap, got %s", third.ID)
	}
	if !p.AtCap("zen") {
		t.Fatal("expected AtCap(zen) to be true")
	}
	p.Release(first.ID)
	if !p.HasCapacity("zen") {
		t.Fatal("expected capacity after release")
	}
	p.Release(second.ID)
}

func TestLatencyRouting(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute, RoutingStrategy: RoutingLatency})
	p.RecordLatency("a1", 900)
	p.RecordLatency("a2", 100)
	got := p.Acquire("zen")
	if got == nil || got.ID != "a2" {
		t.Fatalf("expected fastest a2, got %+v", got)
	}
	p.Release(got.ID)
	if l := p.LatencyOf("a2"); l != 100 {
		t.Fatalf("expected EMA 100, got %d", l)
	}
	if l := p.LatencyOf("nope"); l != -1 {
		t.Fatalf("expected -1 for unknown, got %d", l)
	}
}

func TestStatusStates(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute})
	p.MarkLimited("a1", time.Minute)
	p.MarkInvalid("a2")
	st := p.Status()
	byID := map[string]AccountStatus{}
	for _, s := range st {
		byID[s.ID] = s
	}
	if byID["a1"].State != StateCooling {
		t.Fatalf("a1 should be cooling_down, got %s", byID["a1"].State)
	}
	if byID["a1"].CooldownLeft <= 0 {
		t.Fatal("a1 should report remaining cooldown")
	}
	if byID["a2"].State != StateInvalid {
		t.Fatalf("a2 should be invalid, got %s", byID["a2"].State)
	}
	if byID["a3"].State != StateActive {
		t.Fatalf("a3 should be active, got %s", byID["a3"].State)
	}
}

func TestUsesProxyTriState(t *testing.T) {
	unset := AccountConfig{ID: "x"}
	if !UsesProxy(unset) {
		t.Fatal("unset useProxy should default to true (legacy)")
	}
	off := AccountConfig{ID: "y", UseProxy: boolPtr(false)}
	if UsesProxy(off) {
		t.Fatal("explicit false should opt out of proxy")
	}
	on := AccountConfig{ID: "z", UseProxy: boolPtr(true)}
	if !UsesProxy(on) {
		t.Fatal("explicit true should use proxy")
	}
}

func TestReplacePreservesState(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute})
	p.MarkLimited("a1", time.Minute)
	p.MarkInvalid("a2")
	p.Replace([]AccountConfig{
		{ID: "a1", Name: "one", Provider: "zen", APIKey: "k1", Priority: 1},
		{ID: "b9", Name: "new", Provider: "zen", APIKey: "k9", Priority: 5},
	})
	if !p.IsInvalid("a2") {
		t.Log("note: a2 removed so its invalid flag is dropped (acceptable)")
	}
	// a1 cooling state preserved
	if got := p.Acquire("zen"); got == nil || got.ID != "b9" {
		t.Fatalf("expected b9 while a1 cools, got %+v", got)
	}
}

func TestExhausted(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute})
	if p.Exhausted("zen") {
		t.Fatal("pool should not be exhausted initially")
	}
	p.MarkInvalid("a1")
	p.MarkInvalid("a2")
	if !p.Exhausted("zen") {
		t.Fatal("pool should be exhausted when all invalid")
	}
}

func TestConcurrentAcquireRelease(t *testing.T) {
	p := New(testAccounts(), Options{DefaultCooldownMs: time.Minute, AccountConcurrency: 4})
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if a := p.Acquire("zen"); a != nil {
				time.Sleep(time.Millisecond)
				p.Release(a.ID)
			}
		}()
	}
	wg.Wait()
	for _, s := range p.Status() {
		if s.Inflight != 0 {
			t.Fatalf("leaked inflight slot on %s: %d", s.ID, s.Inflight)
		}
	}
}
