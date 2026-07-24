#!/usr/bin/env bash
# serve-control.sh — expose control plane via Tailscale Serve (shares OTA static root strategy)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

PORT="${BSL_CONTROL_PORT:-8787}"
TS_HOST="${BSL_TS_HOST:-}"
ARTIFACT_ROOT="${BSL_ARTIFACT_ROOT:-$HOME/buildswiftlazily/artifacts}"
ARTIFACT_ROOT="${ARTIFACT_ROOT/#\~/$HOME}"

# Prefer proxying control plane; OTA files are also mounted by control plane under /ota
if ! curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Control plane not healthy on :$PORT — start apps/control-plane first" >&2
  exit 1
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale required" >&2
  exit 1
fi

tailscale serve reset >/dev/null 2>&1 || true
tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}"
echo "Serving control plane at https://${TS_HOST:-<your-ts-host>}/"
tailscale serve status || true
