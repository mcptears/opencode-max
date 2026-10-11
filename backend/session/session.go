// Package session manages per-client Zen session ids (ses_...).
// Community proxies for the Zen free tier attach a session id to requests and
// rotate it whenever a 429 arrives, so a fresh identity is presented on retry.
package session

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// Manager holds the current session id. Safe for concurrent use.
type Manager struct {
	mu        sync.RWMutex
	currentID string
}

// New creates a manager with a fresh session id.
func New() *Manager {
	return &Manager{currentID: Fresh()}
}

// Fresh generates a new session id (ses_ + 32 hex chars).
func Fresh() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("session: crypto/rand unavailable: " + err.Error())
	}
	return "ses_" + hex.EncodeToString(b[:])
}

// ID returns the current session id.
func (m *Manager) ID() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.currentID
}

// Rotate mints a fresh session id and returns it.
func (m *Manager) Rotate() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.currentID = Fresh()
	return m.currentID
}
