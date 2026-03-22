#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/Users/chenxiang/apps"
CONFIG_FILE="${APP_ROOT}/deploy/Caddyfile.local"

if ! command -v caddy >/dev/null 2>&1; then
  echo "caddy not found. Install with: brew install caddy"
  exit 1
fi

exec caddy run --config "${CONFIG_FILE}" --adapter caddyfile
