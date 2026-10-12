package zaitokens

import (
	"testing"

	"github.com/mcptears/opencode-max/db"
)

func TestStoreFIFO(t *testing.T) {
	database, err := db.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	s := NewStore(database)

	if s.Count() != 0 {
		t.Fatal("empty store should count 0")
	}
	if _, ok := s.Take(); ok {
		t.Fatal("Take on empty store should fail")
	}

	added, err := s.Add([]string{"tok-a", "tok-b", "", "tok-a"})
	if err != nil {
		t.Fatal(err)
	}
	if added != 2 {
		t.Fatalf("added = %d, want 2 (blank + dup skipped)", added)
	}
	if s.Count() != 2 {
		t.Fatalf("count = %d, want 2", s.Count())
	}

	// FIFO: oldest first, single-use.
	tok, ok := s.Take()
	if !ok || tok != "tok-a" {
		t.Fatalf("first Take = %q, %v", tok, ok)
	}
	tok, ok = s.Take()
	if !ok || tok != "tok-b" {
		t.Fatalf("second Take = %q, %v", tok, ok)
	}
	if _, ok := s.Take(); ok {
		t.Fatal("pool should be empty after 2 takes")
	}
	if s.Count() != 0 {
		t.Fatalf("count = %d, want 0", s.Count())
	}
}

func TestStoreClear(t *testing.T) {
	database, err := db.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	s := NewStore(database)
	if _, err := s.Add([]string{"x"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	if s.Count() != 0 {
		t.Fatal("Clear should empty the pool")
	}
}

func TestStoreNilSafe(t *testing.T) {
	s := NewStore(nil)
	if s.Count() != 0 {
		t.Fatal("nil store count should be 0")
	}
	if _, ok := s.Take(); ok {
		t.Fatal("nil store Take should fail")
	}
	if err := s.Clear(); err != nil {
		t.Fatal("nil store Clear should not error")
	}
}
