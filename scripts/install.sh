#!/usr/bin/env bash
# One-command install: builds the project and links `opencode-max` onto your PATH.
# Usage: ./scripts/install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed (need Node 18+)" >&2
  exit 1
fi

echo "→ installing dependencies…"
npm install --no-audit --no-fund

echo "→ building…"
npm run build

echo "→ linking \`opencode-max\` onto your PATH (may ask for sudo)…"
if npm link 2>/dev/null; then
  echo "✓ done. Run it with: opencode-max --tray"
else
  echo "npm link needs elevated permissions, retrying with sudo…"
  sudo npm link
  echo "✓ done. Run it with: opencode-max --tray"
fi

echo
echo "Next steps:"
echo "  1. cp accounts.example.json accounts.json   # add your real keys"
echo "  2. opencode-max --open                        # start + open the dashboard"
