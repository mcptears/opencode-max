#!/usr/bin/env bash
# Install opencode-max as a systemd user service (auto-start on login, headless).
# Usage: ./scripts/install-service-linux.sh [--enable-now]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/opencode-max.service"

mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=opencode-max — OpenCode Zen proxy (IP rotation + multi-account)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE $ROOT/dist/index.js
WorkingDirectory=$ROOT
Restart=always
RestartSec=5
Environment=PORT=8080

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
if [[ "${1:-}" == "--enable-now" ]]; then
  systemctl --user enable --now opencode-max
  echo "enabled and started."
else
  systemctl --user enable opencode-max
  echo "installed. Start with: systemctl --user start opencode-max"
fi
echo "Logs: journalctl --user -u opencode-max -f"
