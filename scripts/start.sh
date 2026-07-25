#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ ! -f .env ]]; then
  echo "Copy config/env.example → .env and fill values first." >&2
  exit 1
fi
if [[ ! -f config/repos.yaml ]]; then
  cp config/repos.example.yaml config/repos.yaml
  echo "Created config/repos.yaml — edit GuideAI slug."
fi
cd apps/control-plane
npm install
npm run build
npm start &
PID=$!
sleep 1
cd "$ROOT"
./scripts/serve-control.sh || true
echo "Control plane PID $PID — open https://\$BSL_TS_HOST/ on your phone"
wait $PID
