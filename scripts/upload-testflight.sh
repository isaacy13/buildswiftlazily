#!/usr/bin/env bash
# upload-testflight.sh — validate + upload an App Store IPA to App Store Connect
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: upload-testflight.sh --ipa <path> [options]

Options:
  --platform ios|watchos   IPA type for altool (default ios; Watch IPAs still use ios)
  --skip-validate          Upload without --validate-app first
  --dry-run

Auth (App Store Connect API key — required):
  BSL_ASC_KEY_ID / ASC_KEY_ID
  BSL_ASC_ISSUER_ID / ASC_ISSUER_ID
  AuthKey_<KEY_ID>.p8 in ~/.appstoreconnect/private_keys/
    or BSL_ASC_KEY_PATH / API_PRIVATE_KEYS_DIR (directory or .p8 file)

Uses xcrun altool (--upload-package, falls back to --upload-app).
EOF
}

IPA=""
PLATFORM="ios"
SKIP_VALIDATE=0
DRY_RUN="${BSL_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ipa) IPA="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --skip-validate) SKIP_VALIDATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$IPA" ]] || { usage; exit 2; }
[[ -f "$IPA" ]] || { echo "IPA not found: $IPA" >&2; exit 1; }

PLATFORM="$(printf '%s' "$PLATFORM" | tr '[:upper:]' '[:lower:]')"
# altool --type accepts macos|ios|appletvos|visionos (no watchos). Watch binaries
# ride along an iOS IPA or still upload as type ios.
ALTOOL_TYPE="ios"
if [[ "$PLATFORM" == "macos" || "$PLATFORM" == "appletvos" || "$PLATFORM" == "visionos" ]]; then
  ALTOOL_TYPE="$PLATFORM"
fi

KEY_ID="${BSL_ASC_KEY_ID:-${ASC_KEY_ID:-}}"
ISSUER_ID="${BSL_ASC_ISSUER_ID:-${ASC_ISSUER_ID:-}}"
KEY_PATH="${BSL_ASC_KEY_PATH:-${API_PRIVATE_KEYS_DIR:-}}"

resolve_keys_dir() {
  local candidate="${1:-}"
  if [[ -n "$candidate" ]]; then
    candidate="${candidate/#\~/$HOME}"
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$(cd "$(dirname "$candidate")" && pwd)"
      return 0
    fi
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$(cd "$candidate" && pwd)"
      return 0
    fi
  fi
  local d
  for d in \
    "$HOME/.appstoreconnect/private_keys" \
    "$HOME/private_keys" \
    "$HOME/.private_keys" \
    "./private_keys"; do
    if [[ -d "$d" ]]; then
      printf '%s\n' "$(cd "$d" && pwd)"
      return 0
    fi
  done
  return 1
}

KEYS_DIR=""
if KEYS_DIR="$(resolve_keys_dir "$KEY_PATH")"; then
  export API_PRIVATE_KEYS_DIR="$KEYS_DIR"
fi

IPA_SIZE="$(wc -c <"$IPA" | tr -d ' ')"
IPA_MB="$(awk -v b="$IPA_SIZE" 'BEGIN { printf "%.1f", b/1024/1024 }')"

echo "IPA: $IPA (${IPA_MB} MiB)"
if [[ -n "$KEY_ID" ]]; then
  echo "ASC key id: $KEY_ID"
fi
if [[ -n "${API_PRIVATE_KEYS_DIR:-}" ]]; then
  echo "ASC keys dir: $API_PRIVATE_KEYS_DIR"
  if [[ -n "$KEY_ID" && ! -f "$API_PRIVATE_KEYS_DIR/AuthKey_${KEY_ID}.p8" ]]; then
    echo "Missing $API_PRIVATE_KEYS_DIR/AuthKey_${KEY_ID}.p8" >&2
    echo "Download the .p8 once from App Store Connect → Users and Access → Integrations → App Store Connect API." >&2
    exit 1
  fi
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN: xcrun altool --validate-app -f $IPA --type $ALTOOL_TYPE --apiKey ${KEY_ID:-KEY} --apiIssuer ${ISSUER_ID:-ISSUER}"
  echo "DRY_RUN: xcrun altool --upload-package $IPA --type $ALTOOL_TYPE --apiKey ${KEY_ID:-KEY} --apiIssuer ${ISSUER_ID:-ISSUER} --show-progress"
  echo "TESTFLIGHT_UPLOAD=dry-run"
  exit 0
fi

if [[ -z "$KEY_ID" || -z "$ISSUER_ID" ]]; then
  echo "Set BSL_ASC_KEY_ID and BSL_ASC_ISSUER_ID (App Store Connect API key)" >&2
  exit 1
fi

if [[ -z "${API_PRIVATE_KEYS_DIR:-}" ]]; then
  echo "No ASC private_keys directory found. Create ~/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8" >&2
  exit 1
fi

AUTH=(--apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID")

# Stream altool live into the job log (tee), while keeping a copy for error hints.
run_altool() {
  local logfile status
  logfile="$(mktemp)"
  set +e
  # PIPESTATUS[0] is altool; tee almost always exits 0
  xcrun altool "$@" "${AUTH[@]}" 2>&1 | tee "$logfile"
  status=${PIPESTATUS[0]}
  set -e
  if [[ "$status" -ne 0 ]]; then
    if grep -qiE 'Unable to authenticate|invalid.*key|JWT|401|403|Could not find.*AuthKey' "$logfile"; then
      echo "ASC API auth failed — check BSL_ASC_KEY_ID / ISSUER_ID and AuthKey_${KEY_ID}.p8 (Access: App Manager or Admin)." >&2
    elif grep -qiE 'CFBundleVersion|redundant|already been uploaded|duplicate' "$logfile"; then
      echo "Likely duplicate build number — bump CFBundleVersion in Xcode / agvtool, rebuild, re-upload." >&2
    elif grep -qiE 'No suitable application records|could not find.*app|bundle.*(invalid|mismatch)' "$logfile"; then
      echo "No matching App Store Connect app record for this bundle id — create the app in ASC first." >&2
    fi
  fi
  rm -f "$logfile"
  return "$status"
}

if [[ "$SKIP_VALIDATE" != "1" ]]; then
  echo "Validating IPA with altool (catches common rejections before the long upload)…"
  run_altool --validate-app -f "$IPA" --type "$ALTOOL_TYPE"
  echo "Validation OK."
fi

echo "Uploading to App Store Connect (keep this Mac awake; Ctrl+C aborts the upload)…"
set +e
run_altool --upload-package "$IPA" --type "$ALTOOL_TYPE" --show-progress
UPLOAD_STATUS=$?
if [[ "$UPLOAD_STATUS" -ne 0 ]]; then
  echo "--upload-package failed (exit $UPLOAD_STATUS); trying legacy --upload-app…" >&2
  run_altool --upload-app -f "$IPA" --type "$ALTOOL_TYPE" --show-progress
  UPLOAD_STATUS=$?
fi
set -e
if [[ "$UPLOAD_STATUS" -ne 0 ]]; then
  echo "Upload failed (exit $UPLOAD_STATUS)." >&2
  exit "$UPLOAD_STATUS"
fi

echo "TESTFLIGHT_UPLOAD=ok"
cat <<'EOF'
Upload accepted by App Store Connect.

Next (this is where most “2 hour waits” actually are):
  1. https://appstoreconnect.apple.com → your app → TestFlight → iOS builds
     — do NOT rely only on the TestFlight iPhone app; it hides Processing / Failed builds.
  2. Wait for Processing → Ready to Test (usually minutes; sometimes 1–2h).
  3. If stuck in Processing >2h or Missing Compliance: answer Export Compliance in ASC.
  4. If the build never appears: upload did not succeed (or Ctrl+C killed it) — re-run
     and confirm this script prints TESTFLIGHT_UPLOAD=ok.
  5. Duplicate CFBundleVersion uploads are rejected — bump the build number and retry.
EOF
