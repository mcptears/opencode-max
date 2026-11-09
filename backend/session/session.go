// Package session manages stable Zen session ids (ses_...).
//
// Console routes a conversation consistently and reuses its prompt cache when
// the same x-opencode-session is sent with every request. Go requires the
// header. IDs are therefore stable per account (and therefore per upstream
// credential), not rotated on rate limits: minting a fresh identity to dodge a
// 429 would be circumventing the plan's usage limits.
package session

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// Manager holds stable session ids keyed by account id, plus a fallback id
// for anonymous/keyless requests. Safe for concurrent use.
type Manager struct {
	mu        sync.RWMutex
	defaultID string
	byAccount map[string]string
}

// New creates a manager with a fresh fallback session id.
func New() *Manager {
	return &Manager{
		defaultID: Fresh(),
		byAccount: make(map[string]string),
	}
}

// Fresh generates a new session id (ses_ + 32 hex chars).
func Fresh() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("session: crypto/rand unavailable: " + err.Error())
	}
	return "ses_" + hex.EncodeToString(b[:])
}

// ID returns the fallback session id (used for keyless/anonymous forwards).
func (m *Manager) ID() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.defaultID
}

// IDFor returns the stable session id for an account, creating one lazily.
// An empty account id returns the fallback id.
func (m *Manager) IDFor(accountID string) string {
	if accountID == "" {
		return m.ID()
	}
	m.mu.RLock()
	id, ok := m.byAccount[accountID]
	m.mu.RUnlock()
	if ok {
		return id
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.byAccount[accountID]; ok {
		return id
	}
	id = Fresh()
	m.byAccount[accountID] = id
	return id
}

// Forget drops an account's session id (e.g. when the account is removed).
func (m *Manager) Forget(accountID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.byAccount, accountID)
}

// Rotate mints a fresh fallback id. Retained for explicit/manual resets only;
// rate-limit handling must never call it.
func (m *Manager) Rotate() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.defaultID = Fresh()
	return m.defaultID
}
