#!/usr/bin/env bash
# serve-ota.sh — publish IPA + manifest over local HTTP + Tailscale Serve
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: serve-ota.sh --ipa <path> --artifact-id <id> [options]
       serve-ota.sh --serve-only

Options:
  --ipa PATH
  --artifact-id ID     URL segment (UUID recommended)
  --title NAME         Display name
  --bundle-id ID
  --bundle-version VER
  --ts-host HOST       MagicDNS name (or BSL_TS_HOST)
  --port N             Local HTTP port (default BSL_OTA_PORT or 8788)
  --artifact-root PATH (default ~/buildswiftlazily/artifacts)
  --serve-only         Only ensure HTTP + tailscale serve are up
  --dry-run
EOF
}

IPA=""
ARTIFACT_ID=""
TITLE="App"
BUNDLE_ID="com.example.app"
BUNDLE_VERSION="1"
TS_HOST="${BSL_TS_HOST:-}"
PORT="${BSL_OTA_PORT:-8788}"
ARTIFACT_ROOT="${BSL_ARTIFACT_ROOT:-$HOME/buildswiftlazily/artifacts}"
SERVE_ONLY=0
DRY_RUN="${BSL_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ipa) IPA="$2"; shift 2 ;;
    --artifact-id) ARTIFACT_ID="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --bundle-version) BUNDLE_VERSION="$2"; shift 2 ;;
    --ts-host) TS_HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --artifact-root) ARTIFACT_ROOT="$2"; shift 2 ;;
    --serve-only) SERVE_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage; exit 2 ;;
  esac
done

ARTIFACT_ROOT="${ARTIFACT_ROOT/#\~/$HOME}"
mkdir -p "$ARTIFACT_ROOT"
STATIC_ROOT="$ARTIFACT_ROOT/www"
mkdir -p "$STATIC_ROOT"

run() {
  if [[ "$DRY_RUN" == "1" ]]; then echo "DRY_RUN: $*"; else "$@"; fi
}

CONTROL_PORT="${BSL_CONTROL_PORT:-8787}"

control_plane_up() {
  curl -sf "http://127.0.0.1:${CONTROL_PORT}/api/health" >/dev/null 2>&1
}

ensure_server() {
  # Prefer the control plane (serves UI + /ota/*). Avoid resetting Tailscale Serve
  # out from under it when a deploy finishes.
  if control_plane_up; then
    echo "Control plane healthy on :$CONTROL_PORT — reusing it for OTA"
    if command -v tailscale >/dev/null 2>&1 && [[ "$DRY_RUN" != "1" ]]; then
      # Ensure Serve points at control plane (idempotent enough for personal use)
      tailscale serve --bg --https=443 "http://127.0.0.1:${CONTROL_PORT}" >/dev/null 2>&1 || true
    fi
    return 0
  fi

  # Fallback: standalone static server when control plane is not running
  PID_FILE="$ARTIFACT_ROOT/http.pid"
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "HTTP server already running pid=$(cat "$PID_FILE")"
  else
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "DRY_RUN: python3 -m http.server $PORT in $STATIC_ROOT"
    else
      (
        cd "$STATIC_ROOT"
        nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >"$ARTIFACT_ROOT/http.log" 2>&1 &
        echo $! >"$PID_FILE"
      )
      sleep 0.5
      echo "Started HTTP server on 127.0.0.1:$PORT"
    fi
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY_RUN: tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
    return 0
  fi

  if ! command -v tailscale >/dev/null 2>&1; then
    echo "tailscale CLI required" >&2
    exit 1
  fi

  tailscale serve reset >/dev/null 2>&1 || true
  tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}"
  echo "tailscale serve → http://127.0.0.1:${PORT}"
}

if [[ "$SERVE_ONLY" == "1" ]]; then
  ensure_server
  if [[ -n "$TS_HOST" ]]; then
    echo "INSTALL_BASE=https://${TS_HOST}"
  fi
  exit 0
fi

[[ -n "$IPA" && -n "$ARTIFACT_ID" ]] || { usage; exit 2; }
[[ -f "$IPA" ]] || { echo "IPA not found: $IPA" >&2; exit 1; }
[[ -n "$TS_HOST" ]] || { echo "BSL_TS_HOST / --ts-host required" >&2; exit 1; }

# sanitize artifact id
if [[ ! "$ARTIFACT_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Invalid artifact-id" >&2
  exit 2
fi

DEST="$STATIC_ROOT/ota/$ARTIFACT_ID"
mkdir -p "$DEST"
cp "$IPA" "$DEST/App.ipa"

BASE="https://${TS_HOST}/ota/${ARTIFACT_ID}"
IPA_URL="${BASE}/App.ipa"
MANIFEST_URL="${BASE}/manifest.plist"

# Escape XML special chars lightly
xml_esc() { python3 -c 'import sys,xml.sax.saxutils; print(xml.sax.saxutils.escape(sys.stdin.read().rstrip("\n")))' <<<"$1"; }

TITLE_X="$(xml_esc "$TITLE")"
BUNDLE_X="$(xml_esc "$BUNDLE_ID")"
VER_X="$(xml_esc "$BUNDLE_VERSION")"

cat > "$DEST/manifest.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${IPA_URL}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${BUNDLE_X}</string>
        <key>bundle-version</key>
        <string>${VER_X}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${TITLE_X}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
EOF

ITMS="itms-services://?action=download-manifest&url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$MANIFEST_URL")"

cat > "$DEST/index.html" <<EOF
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Install ${TITLE_X}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 2rem; background: #0b0b0c; color: #f5f5f7; }
    .card { max-width: 28rem; margin: 0 auto; background: #1c1c1e; border-radius: 16px; padding: 1.5rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { color: #a1a1a6; line-height: 1.4; }
    a.btn { display: block; text-align: center; background: #0a84ff; color: white; text-decoration: none;
            font-weight: 600; padding: 0.9rem 1rem; border-radius: 12px; margin-top: 1.25rem; }
    code { font-size: 0.75rem; word-break: break-all; color: #8e8e93; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Install ${TITLE_X}</h1>
    <p>Version ${VER_X}<br/>Open this page in <strong>Safari</strong> on a registered device.</p>
    <a class="btn" href="${ITMS}">Install on this iPhone</a>
    <p style="margin-top:1rem"><code>${MANIFEST_URL}</code></p>
  </div>
</body>
</html>
EOF

# Also write metadata for control plane
cat > "$DEST/meta.json" <<EOF
{
  "id": "$(xml_esc "$ARTIFACT_ID" | sed 's/"/\\"/g')",
  "title": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$TITLE"),
  "bundleId": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$BUNDLE_ID"),
  "bundleVersion": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$BUNDLE_VERSION"),
  "installUrl": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$BASE/"),
  "itmsUrl": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$ITMS"),
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

ensure_server

echo "INSTALL_URL=${BASE}/"
echo "ITMS_URL=${ITMS}"
echo "ARTIFACT_ID=${ARTIFACT_ID}"
