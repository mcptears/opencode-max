package session

import (
	"strings"
	"sync"
	"testing"
)

func TestFreshFormat(t *testing.T) {
	id := Fresh()
	if !strings.HasPrefix(id, "ses_") {
		t.Fatalf("expected ses_ prefix, got %q", id)
	}
	if len(id) != 4+32 {
		t.Fatalf("expected 36 chars, got %d (%q)", len(id), id)
	}
	if Fresh() == Fresh() {
		t.Fatal("two fresh ids should differ")
	}
}

func TestRotate(t *testing.T) {
	m := New()
	first := m.ID()
	if first == "" {
		t.Fatal("expected non-empty initial id")
	}
	second := m.Rotate()
	if second == first {
		t.Fatal("rotate should mint a new id")
	}
	if m.ID() != second {
		t.Fatal("ID() should return the rotated id")
	}
}

func TestConcurrent(t *testing.T) {
	m := New()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = m.ID()
			_ = m.Rotate()
		}()
	}
	wg.Wait()
	if m.ID() == "" {
		t.Fatal("expected non-empty id after concurrent use")
	}
}
