import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot } from './paths.js';

/**
 * Embedded SQLite store (Node's built-in node:sqlite, no extra dependency).
 * Holds quota usage events and, later, metrics history. WAL mode for safe
 * concurrent reads while the proxy serves traffic.
 */
let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const dir = path.join(projectRoot(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'opencode-max.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    ts INTEGER NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_account_ts ON usage_events(account_id, ts);');
  return db;
}
