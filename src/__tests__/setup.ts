import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the SQLite database per test run and shrink the quota window
// before any module (settings/db) is imported.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-test-'));
process.env.OM_DATA_DIR = dir;
process.env.QUOTA_5H_LIMIT = '3';
