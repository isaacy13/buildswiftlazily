#!/usr/bin/env bash
# upload-testflight.sh — upload an App Store IPA to App Store Connect / TestFlight
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: upload-testflight.sh --ipa <path> [--dry-run]

Auth (preferred): App Store Connect API key
  ASC_KEY_ID / BSL_ASC_KEY_ID
  ASC_ISSUER_ID / BSL_ASC_ISSUER_ID
  Place AuthKey_<KEY_ID>.p8 in ~/.appstoreconnect/private_keys/
    or set API_PRIVATE_KEYS_DIR / BSL_ASC_KEY_PATH (directory or file)

Uses: xcrun altool --upload-app
EOF
}

IPA=""
DRY_RUN="${BSL_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ipa) IPA="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$IPA" ]] || { usage; exit 2; }
[[ -f "$IPA" ]] || { echo "IPA not found: $IPA" >&2; exit 1; }

KEY_ID="${BSL_ASC_KEY_ID:-${ASC_KEY_ID:-}}"
ISSUER_ID="${BSL_ASC_ISSUER_ID:-${ASC_ISSUER_ID:-}}"
KEY_PATH="${BSL_ASC_KEY_PATH:-${API_PRIVATE_KEYS_DIR:-}}"

if [[ -n "$KEY_PATH" ]]; then
  if [[ -f "$KEY_PATH" ]]; then
    export API_PRIVATE_KEYS_DIR="$(cd "$(dirname "$KEY_PATH")" && pwd)"
  elif [[ -d "$KEY_PATH" ]]; then
    export API_PRIVATE_KEYS_DIR="$(cd "$KEY_PATH" && pwd)"
  fi
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN: xcrun altool --upload-app -f $IPA -t ios --apiKey ${KEY_ID:-KEY} --apiIssuer ${ISSUER_ID:-ISSUER}"
  echo "TESTFLIGHT_UPLOAD=dry-run"
  exit 0
fi

if [[ -z "$KEY_ID" || -z "$ISSUER_ID" ]]; then
  echo "Set BSL_ASC_KEY_ID and BSL_ASC_ISSUER_ID (App Store Connect API key)" >&2
  exit 1
fi

echo "Uploading $IPA to App Store Connect (TestFlight)…"
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID"
echo "TESTFLIGHT_UPLOAD=ok"
echo "Open TestFlight after processing completes (often a few minutes)."
