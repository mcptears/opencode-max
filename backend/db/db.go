// Package db owns the embedded SQLite store (pure-Go via modernc.org/sqlite).
//
// Tables:
//   - usage_events  — per-account request timestamps for the 5h quota window
//   - metric_events — system event feed (rate limits, rotations, failovers…)
//   - request_log   — completed proxied requests (model, account, status, latency)
//   - token_usage   — prompt/completion token counts sniffed from responses
//   - kv_store      — small key/value pairs (e.g. the Logs-tab clear cutoff)
//
// All methods must keep working when the DB is unavailable: callers swallow
// errors so persistence can never break proxying.
package db

import (
	"database/sql"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_account_ts ON usage_events(account_id, ts);
CREATE TABLE IF NOT EXISTS metric_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metric_ts ON metric_events(ts);
CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_ts ON request_log(ts);
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(ts);
CREATE TABLE IF NOT EXISTS kv_store (
  k TEXT PRIMARY KEY,
  v TEXT
);
`

// Open creates the data directory if needed and opens (creating) the
// opencode-max.db SQLite database inside it, applying the schema.
func Open(dataDir string) (*sql.DB, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	database, err := sql.Open("sqlite", filepath.Join(dataDir, "opencode-max.db"))
	if err != nil {
		return nil, err
	}
	if _, err := database.Exec(schema); err != nil {
		_ = database.Close()
		return nil, err
	}
	return database, nil
}

// OpenMemory opens an isolated in-memory database (useful for tests).
// MaxOpenConns is pinned to 1 so the memory DB is shared across queries.
func OpenMemory() (*sql.DB, error) {
	database, err := sql.Open("sqlite", "file::memory:?cache=shared")
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	if _, err := database.Exec(schema); err != nil {
		_ = database.Close()
		return nil, err
	}
	return database, nil
}

// DataDir resolves the database directory: OM_DATA_DIR wins, otherwise
// ./data under the current working directory.
func DataDir() string {
	if dir := os.Getenv("OM_DATA_DIR"); dir != "" {
		return dir
	}
	return "data"
}
