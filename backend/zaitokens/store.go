// Package zaitokens owns the Z.ai device-token pool.
//
// Device tokens are Aliyun fingerprints harvested automatically from a real
// browser (window.z_um.getToken() at chat.z.ai) by the zai-collect helper.
// Each token is single-use: Take removes it FIFO, matching the reference
// method. The zai provider consumes from this pool automatically when an
// account has no per-account device token set.
package zaitokens

import (
	"database/sql"
	"time"
)

const schema = `
CREATE TABLE IF NOT EXISTS zai_device_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zai_tokens_id ON zai_device_tokens(id);
`

// EnsureSchema creates the token table. Safe to call repeatedly.
func EnsureSchema(database *sql.DB) error {
	_, err := database.Exec(schema)
	return err
}

// Store is a FIFO pool of single-use device tokens.
type Store struct {
	db *sql.DB
}

// NewStore wraps database (nil-safe: all methods no-op gracefully).
func NewStore(database *sql.DB) *Store { return &Store{db: database} }

// Add inserts tokens, skipping blanks and duplicates already in the pool.
func (s *Store) Add(tokens []string) (int, error) {
	if s.db == nil {
		return 0, sql.ErrConnDone
	}
	if err := EnsureSchema(s.db); err != nil {
		return 0, err
	}
	added := 0
	now := time.Now().UnixMilli()
	for _, tok := range tokens {
		if tok == "" {
			continue
		}
		var exists int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM zai_device_tokens WHERE token = ?`, tok).Scan(&exists); err != nil {
			return added, err
		}
		if exists > 0 {
			continue
		}
		if _, err := s.db.Exec(`INSERT INTO zai_device_tokens (token, created_at) VALUES (?, ?)`, tok, now); err != nil {
			return added, err
		}
		added++
	}
	return added, nil
}

// Take removes and returns the oldest token (FIFO). ok=false when empty.
func (s *Store) Take() (token string, ok bool) {
	if s.db == nil {
		return "", false
	}
	if err := EnsureSchema(s.db); err != nil {
		return "", false
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", false
	}
	defer tx.Rollback()
	var id int64
	if err := tx.QueryRow(`SELECT id, token FROM zai_device_tokens ORDER BY id LIMIT 1`).Scan(&id, &token); err != nil {
		return "", false
	}
	if _, err := tx.Exec(`DELETE FROM zai_device_tokens WHERE id = ?`, id); err != nil {
		return "", false
	}
	if err := tx.Commit(); err != nil {
		return "", false
	}
	return token, true
}

// Count returns the number of tokens currently pooled.
func (s *Store) Count() int {
	if s.db == nil {
		return 0
	}
	if err := EnsureSchema(s.db); err != nil {
		return 0
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM zai_device_tokens`).Scan(&n); err != nil {
		return 0
	}
	return n
}

// Clear empties the pool.
func (s *Store) Clear() error {
	if s.db == nil {
		return nil
	}
	if err := EnsureSchema(s.db); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM zai_device_tokens`)
	return err
}
