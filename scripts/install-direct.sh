#!/usr/bin/env bash
# install-direct.sh — install + launch .app on a paired iPhone or Apple Watch via devicectl
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-direct.sh --app <Path/To/App.app> [options]

Options:
  --device <uuid>              Core Device / UDID (optional; auto-picks when omitted)
  --device-class phone|watch|any   Prefer iPhone, Apple Watch, or either (default: phone)
  --bundle-id <id>             Launch after install (optional; read from Info.plist)
  --dry-run
EOF
}

APP=""
DEVICE="${BSL_DEVICE_ID:-}"
DEVICE_CLASS="${BSL_DEVICE_CLASS:-phone}"
BUNDLE_ID=""
DRY_RUN="${BSL_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --device-class) DEVICE_CLASS="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$APP" ]] || { usage; exit 2; }
[[ -d "$APP" ]] || { echo "App bundle not found: $APP" >&2; exit 1; }

DEVICE_CLASS="$(printf '%s' "$DEVICE_CLASS" | tr '[:upper:]' '[:lower:]')"
if [[ "$DEVICE_CLASS" != "phone" && "$DEVICE_CLASS" != "watch" && "$DEVICE_CLASS" != "any" ]]; then
  echo "Invalid --device-class (expected phone|watch|any)" >&2
  exit 2
fi

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
  local json_file class="$1"
  json_file="$(mktemp)"
  # Prefer --json-output path (Xcode 15+). Fall back to plain text parse.
  if xcrun devicectl list devices --json-output "$json_file" >/dev/null 2>&1; then
    python3 - "$json_file" "$class" <<'PY'
import json, sys
path, want = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
phones, watches = [], []

def classify(name, dtype):
    blob = f"{name} {dtype}".lower()
    if "watch" in blob:
        return "watch"
    if "iphone" in blob or "ipod" in blob:
        return "phone"
    return None

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
        kind = classify(name, dtype)
        if udid and kind == "phone":
            phones.append(str(udid))
        elif udid and kind == "watch":
            watches.append(str(udid))
        for v in o.values():
            walk(v)
    elif isinstance(o, list):
        for i in o:
            walk(i)

walk(data)
if want == "watch":
    candidates = watches
elif want == "any":
    candidates = phones + watches
else:
    candidates = phones
if candidates:
    print(candidates[0])
PY
  else
    local text
    text="$(xcrun devicectl list devices 2>/dev/null || true)"
    DEVICE_FROM_TEXT="$(printf '%s\n' "$text" | python3 -c '
import re, sys
want = "'"$class"'"
uuid_re = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")
phones, watches = [], []
for line in sys.stdin:
    low = line.lower()
    m = uuid_re.search(line)
    if not m:
        continue
    if "watch" in low:
        watches.append(m.group(0))
    elif "iphone" in low or "ipod" in low:
        phones.append(m.group(0))
if want == "watch":
    c = watches
elif want == "any":
    c = phones + watches
else:
    c = phones
if c:
    print(c[0])
')"
    printf '%s' "$DEVICE_FROM_TEXT"
  fi
  rm -f "$json_file"
}

if [[ -z "$DEVICE" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    DEVICE="dry-run-device"
  else
    DEVICE="$(pick_device "$DEVICE_CLASS" || true)"
  fi
fi

if [[ -z "$DEVICE" ]]; then
  if [[ "$DEVICE_CLASS" == "watch" ]]; then
    echo "No paired Apple Watch found via devicectl. Pair the Watch to a nearby iPhone/Mac, enable Developer Mode on the Watch, or use TestFlight." >&2
  else
    echo "No paired iPhone found via devicectl. Connect/pair the device or use OTA mode." >&2
  fi
  xcrun devicectl list devices 2>/dev/null || true
  exit 1
fi

echo "Installing to device $DEVICE (class=$DEVICE_CLASS)…"
run xcrun devicectl device install app --device "$DEVICE" "$APP"

if [[ -z "$BUNDLE_ID" ]]; then
  if [[ -x /usr/libexec/PlistBuddy ]]; then
    BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" 2>/dev/null || true)"
  fi
fi

if [[ -n "$BUNDLE_ID" ]]; then
  echo "Launching $BUNDLE_ID …"
  run xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" || {
    echo "Install OK but launch failed — open the app manually on the device." >&2
  }
else
  echo "Install OK (bundle id unknown; skip launch)"
fi
