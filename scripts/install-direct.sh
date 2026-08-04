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

if [[ "$DRY_RUN" != "1" ]]; then
  if ! xcrun devicectl --help >/dev/null 2>&1; then
    echo "devicectl unavailable — use OTA mode" >&2
    exit 1
  fi
fi

pick_device() {
  # Write JSON to a file first — a heredoc would steal stdin from a pipe.
  local json_file
  json_file="$(mktemp)"
  # Prefer --json-output path (Xcode 15+). Fall back to plain text parse.
  if xcrun devicectl list devices --json-output "$json_file" >/dev/null 2>&1; then
    python3 - "$json_file" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
candidates = []

def walk(o):
    if isinstance(o, dict):
        name = str(o.get("name") or o.get("deviceName") or "")
        udid = (
            o.get("identifier")
            or o.get("udid")
            or o.get("coreDeviceId")
            or (o.get("hardwareProperties") or {}).get("udid")
        )
        dtype = str(
            o.get("deviceType")
            or (o.get("hardwareProperties") or {}).get("deviceType")
            or ""
        )
        if udid and ("iPhone" in name or "iphone" in dtype.lower() or "iPhone" in dtype):
            candidates.append(str(udid))
        for v in o.values():
            walk(v)
    elif isinstance(o, list):
        for i in o:
            walk(i)

walk(data)
if candidates:
    print(candidates[0])
PY
  else
    # Text fallback: capture output first so a heredoc cannot steal stdin from a pipe.
    local text
    text="$(xcrun devicectl list devices 2>/dev/null || true)"
    DEVICE_FROM_TEXT="$(printf '%s\n' "$text" | python3 -c '
import re, sys
uuid_re = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")
for line in sys.stdin:
    if "iPhone" not in line and "iphone" not in line.lower():
        continue
    m = uuid_re.search(line)
    if m:
        print(m.group(0))
        break
')"
    printf '%s' "$DEVICE_FROM_TEXT"
  fi
  rm -f "$json_file"
}

if [[ -z "$DEVICE" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    DEVICE="dry-run-device"
  else
    DEVICE="$(pick_device || true)"
  fi
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
