#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "No .env — run ./scripts/bootstrap.sh first (copies templates + builds control plane)." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source "$ROOT/.env"; set +a

if [[ ! -f config/repos.yaml ]]; then
  cp config/repos.example.yaml config/repos.yaml
  echo "Created config/repos.yaml — edit your app owner/repo slug."
fi

if [[ ! -d apps/control-plane/node_modules || ! -f apps/control-plane/dist/server.js ]]; then
  echo "Control plane not built yet — running bootstrap…"
  "$ROOT/scripts/bootstrap.sh"
fi

PORT="${BSL_CONTROL_PORT:-8787}"
if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Control plane already healthy on :$PORT"
else
  cd apps/control-plane
  # Own process group so Ctrl+C on this helper shell does not kill a mid-flight build.
  npm start &
  PID=$!
  disown "$PID" 2>/dev/null || true
  cd "$ROOT"
  echo "Starting control plane (pid $PID)…"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  if ! curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "Control plane failed to become healthy on :$PORT" >&2
    kill "$PID" 2>/dev/null || true
    exit 1
  fi
fi

"$ROOT/scripts/serve-control.sh" || {
  echo "Tailscale Serve not configured yet — API is still on http://127.0.0.1:${PORT}" >&2
  echo "Fix Tailscale, then re-run: ./scripts/serve-control.sh" >&2
}

HOST="${BSL_TS_HOST:-<your-ts-host>}"
echo
echo "Open on your phone (Tailscale connected):"
echo "  https://${HOST}/"
echo "Local: http://127.0.0.1:${PORT}/"
echo
echo "Ctrl+C leaves the control plane running (needed for long builds/uploads)."
echo "Stop it later with: kill \$(lsof -t -iTCP:${PORT} -sTCP:LISTEN)   # or kill the node pid"
# Keep this shell open for convenience, but never SIGINT the server.
trap 'echo; echo "Leaving control plane up on :${PORT}. Bye."; exit 0' INT TERM
if [[ -n "${PID:-}" ]]; then
  # Poll instead of wait so Ctrl+C hits our trap, not the child.
  while kill -0 "$PID" 2>/dev/null; do
    sleep 2
  done
  echo "Control plane (pid $PID) exited."
else
  echo "Press Ctrl+C to exit this helper (server keeps running)."
  while true; do sleep 3600; done
fi
