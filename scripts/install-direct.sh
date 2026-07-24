#!/usr/bin/env bash
# install-direct.sh — install + launch .app on a paired iPhone via devicectl
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-direct.sh --app <Path/To/App.app> [--device <coredevice-uuid>] [--bundle-id <id>] [--dry-run]
EOF
}

APP=""
DEVICE="${BSL_DEVICE_ID:-}"
BUNDLE_ID=""
DRY_RUN="${BSL_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$APP" ]] || { usage; exit 2; }
[[ -d "$APP" ]] || { echo "App bundle not found: $APP" >&2; exit 1; }

run() {
  if [[ "$DRY_RUN" == "1" ]]; then echo "DRY_RUN: $*"; else "$@"; fi
}

if ! xcrun devicectl --help >/dev/null 2>&1; then
  echo "devicectl unavailable — use OTA mode" >&2
  exit 1
fi

if [[ -z "$DEVICE" ]]; then
  # Pick first available iPhone-like device UUID from JSON if possible
  DEVICE="$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null | python3 - <<'PY' || true
import json,sys
try:
    data=json.load(sys.stdin)
except Exception:
    sys.exit(0)
# Shape varies by Xcode version; try common paths
candidates=[]
def walk(o):
    if isinstance(o, dict):
        name=str(o.get("name") or o.get("deviceName") or "")
        udid=o.get("identifier") or o.get("udid") or o.get("coreDeviceId") or o.get("hardwareProperties",{}).get("udid")
        state=str(o.get("state") or o.get("connectionState") or o.get("visibility") or "")
        dtype=str(o.get("deviceType") or o.get("hardwareProperties",{}).get("deviceType") or "")
        if udid and ("iPhone" in name or "iPhone" in dtype or "iphone" in dtype.lower()):
            candidates.append((str(udid), name, state))
        for v in o.values():
            walk(v)
    elif isinstance(o, list):
        for i in o:
            walk(i)
walk(data)
for udid,name,state in candidates:
    print(udid)
    break
PY
)"
fi

if [[ -z "$DEVICE" ]]; then
  echo "No paired iPhone found via devicectl. Connect/pair the device or use OTA mode." >&2
  xcrun devicectl list devices 2>/dev/null || true
  exit 1
fi

echo "Installing to device $DEVICE …"
run xcrun devicectl device install app --device "$DEVICE" "$APP"

if [[ -z "$BUNDLE_ID" ]]; then
  if [[ -x /usr/libexec/PlistBuddy ]]; then
    BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" 2>/dev/null || true)"
  fi
fi

if [[ -n "$BUNDLE_ID" ]]; then
  echo "Launching $BUNDLE_ID …"
  run xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" || {
    echo "Install OK but launch failed — open the app manually on the phone." >&2
  }
else
  echo "Install OK (bundle id unknown; skip launch)"
fi
