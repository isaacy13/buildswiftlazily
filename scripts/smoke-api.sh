#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8799}"
cd "$ROOT/apps/control-plane"
npm run build >/dev/null
BSL_CONTROL_PORT="$PORT" BSL_ARTIFACT_ROOT=/tmp/bsl-smoke-artifacts BSL_ALLOW_INSECURE_API=1 node dist/server.js >/tmp/bsl-smoke.log 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT
for i in 1 2 3 4 5; do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.4; done
curl -sf "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true'
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[[ "$code" == "200" ]]
echo "smoke-api ok"
