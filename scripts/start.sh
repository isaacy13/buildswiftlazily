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

PORT="${BSL_CONTROL_PORT:-8787}"

# Always rebuild so branch checkouts / PWA fixes actually reach the phone.
# Set BSL_START_SKIP_BUILD=1 to skip (faster loop when you know dist is fresh).
if [[ "${BSL_START_SKIP_BUILD:-0}" != "1" ]]; then
  echo "Building control plane (API + PWA)…"
  if [[ ! -d apps/control-plane/node_modules ]]; then
    (cd apps/control-plane && npm install --no-audit --no-fund)
  fi
  (cd apps/control-plane && npm run build)
else
  if [[ ! -d apps/control-plane/node_modules || ! -f apps/control-plane/dist/server.js ]]; then
    echo "Control plane not built yet — running bootstrap…"
    "$ROOT/scripts/bootstrap.sh"
  fi
fi

bsl_kill_port_listeners() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if [[ -z "$pids" ]] && command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "${port}/tcp" 2>/dev/null || true)"
  fi
  if [[ -z "$pids" ]]; then
    return 0
  fi
  echo "Stopping previous control plane on :$port (pids: $pids)"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
  sleep 0.5
}

# Re-running start.sh used to no-op when :PORT was already healthy — that left
# the phone stuck on an old PWA bundle / old reattach logic after git checkout.
if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Control plane already on :$PORT — restarting so this checkout's build is served."
  echo "(In-memory job UI state resets; a detached xcodebuild may keep running.)"
  bsl_kill_port_listeners "$PORT"
fi

cd apps/control-plane
# Own process group so Ctrl+C on this helper shell does not kill a mid-flight build.
npm start &
PID=$!
disown "$PID" 2>/dev/null || true
cd "$ROOT"
echo "Starting control plane (pid $PID)…"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.4
done
if ! curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Control plane failed to become healthy on :$PORT" >&2
  kill "$PID" 2>/dev/null || true
  exit 1
fi

WEB_JS="$(curl -sf "http://127.0.0.1:${PORT}/api/health" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("webBuild") or "")' 2>/dev/null || true)"
if [[ -n "$WEB_JS" ]]; then
  echo "Serving PWA build: $WEB_JS"
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
echo "If the phone still looks stale: close the PWA from the app switcher,"
echo "re-open https://${HOST}/ once in Safari, then re-Add to Home Screen."
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
