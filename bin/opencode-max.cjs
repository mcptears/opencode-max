#!/usr/bin/env node
// Global `opencode-max` launcher. Installed on PATH via `npm install -g` / `npm link`.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'dist', 'index.js');

if (!fs.existsSync(entry)) {
  console.error('opencode-max: built files not found.');
  console.error(`Expected: ${entry}`);
  console.error('Fix: cd into the package directory and run `npm install && npm run build`, then link/install again.');
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  });
}
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
child.on('error', (err) => {
  console.error('opencode-max: failed to start:', err.message);
  process.exit(1);
});
