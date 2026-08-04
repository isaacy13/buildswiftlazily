#!/usr/bin/env bash
# serve-control.sh — expose control plane via Tailscale Serve (shares OTA static root strategy)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

PORT="${BSL_CONTROL_PORT:-8787}"
TS_HOST="${BSL_TS_HOST:-}"

# Prefer proxying control plane; OTA files are also mounted by control plane under /ota
if ! curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Control plane not healthy on :$PORT — start apps/control-plane first" >&2
  exit 1
fi

if ! bsl_find_tailscale >/dev/null; then
  echo "tailscale CLI required for Serve (install from Tailscale.app or brew)" >&2
  exit 1
fi

bsl_tailscale serve reset >/dev/null 2>&1 || true
bsl_tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}"
echo "Serving control plane at https://${TS_HOST:-<your-ts-host>}/"
bsl_tailscale serve status || true
