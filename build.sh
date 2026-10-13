#!/bin/bash
# Builds all Hadi binaries (Linux/macOS). Run from the repo root after git pull.
set -e
cd "$(dirname "$0")/backend"
echo "Building hadi-server..."
go build -o hadi-server .
echo "Building qwen-login..."
go build -o qwen-login ./cmd/qwen-login
echo "Building zai-collect..."
go build -o zai-collect ./cmd/zai-collect
echo
echo "Done. Restart hadi-server: ./backend/hadi-server"
