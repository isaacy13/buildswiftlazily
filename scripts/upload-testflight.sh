#!/usr/bin/env bash
# upload-testflight.sh — validate + upload an App Store IPA to App Store Connect
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: upload-testflight.sh --ipa <path> [options]

Options:
  --platform ios|watchos   IPA type for altool (default ios; Watch IPAs still use ios)
  --bundle-id ID           CFBundleIdentifier (read from IPA when omitted)
  --bundle-version VER     CFBundleVersion (read from IPA when omitted)
  --bundle-short-version V CFBundleShortVersionString (read from IPA when omitted)
  --apple-id ID            App Store Connect numeric Apple ID (or BSL_ASC_APPLE_ID)
  --skip-validate          Upload without --validate-app first
  --dry-run

Auth (App Store Connect API key — required):
  BSL_ASC_KEY_ID / ASC_KEY_ID
  BSL_ASC_ISSUER_ID / ASC_ISSUER_ID
  AuthKey_<KEY_ID>.p8 in ~/.appstoreconnect/private_keys/
    or BSL_ASC_KEY_PATH / API_PRIVATE_KEYS_DIR (directory or .p8 file)

Uses xcrun altool --upload-package with the bundle metadata Apple requires.
--bundle-id, version, and --apple-id are required; without --apple-id altool
prints ERROR 21 and may still exit 0 (a false TESTFLIGHT_UPLOAD=ok). Missing
bundle metadata can also make Transporter treat the IPA as a generic package
(ASC email ITMS-90018, file extension must be .zip).
EOF
}

IPA=""
PLATFORM="ios"
SKIP_VALIDATE=0
DRY_RUN="${BSL_DRY_RUN:-0}"
BUNDLE_ID=""
BUNDLE_VERSION=""
BUNDLE_SHORT=""
APPLE_ID="${BSL_ASC_APPLE_ID:-${ASC_APPLE_ID:-}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ipa) IPA="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --bundle-version) BUNDLE_VERSION="$2"; shift 2 ;;
    --bundle-short-version) BUNDLE_SHORT="$2"; shift 2 ;;
    --apple-id) APPLE_ID="$2"; shift 2 ;;
    --skip-validate) SKIP_VALIDATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$IPA" ]] || { usage; exit 2; }
[[ -f "$IPA" ]] || { echo "IPA not found: $IPA" >&2; exit 1; }

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_ROOT/scripts/lib.sh"

PLATFORM="$(printf '%s' "$PLATFORM" | tr '[:upper:]' '[:lower:]')"
# altool --type accepts macos|ios|appletvos|visionos (no watchos). Watch binaries
# ride along an iOS IPA or still upload as type ios.
ALTOOL_TYPE="ios"
if [[ "$PLATFORM" == "macos" || "$PLATFORM" == "appletvos" || "$PLATFORM" == "visionos" ]]; then
  ALTOOL_TYPE="$PLATFORM"
fi

# Fill bundle identity from the IPA when the caller didn't pass it.
if [[ -z "$BUNDLE_ID" || -z "$BUNDLE_VERSION" || -z "$BUNDLE_SHORT" ]]; then
  IDENT="$(bsl_ipa_bundle_identity "$IPA" || true)"
  if [[ -n "$IDENT" ]]; then
    IFS=$'\t' read -r IPA_BID IPA_VER IPA_SHORT <<<"$IDENT"
    [[ -n "$BUNDLE_ID" ]] || BUNDLE_ID="$IPA_BID"
    [[ -n "$BUNDLE_VERSION" ]] || BUNDLE_VERSION="$IPA_VER"
    [[ -n "$BUNDLE_SHORT" ]] || BUNDLE_SHORT="$IPA_SHORT"
  fi
fi

if [[ "$DRY_RUN" != "1" ]]; then
  bsl_assert_ipa_payload "$IPA" || {
    echo "IPA is not a valid App Store zip (ITMS-90018). Rebuild with TestFlight mode so archive symlinks are materialized." >&2
    exit 1
  }
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
if [[ -n "$BUNDLE_ID" ]]; then
  echo "Bundle id: $BUNDLE_ID"
fi
if [[ -n "$BUNDLE_VERSION" ]]; then
  echo "CFBundleVersion: $BUNDLE_VERSION"
fi
if [[ -n "$BUNDLE_SHORT" ]]; then
  echo "CFBundleShortVersionString: $BUNDLE_SHORT"
fi
if [[ -n "$BUNDLE_ID" && -n "$BUNDLE_VERSION" ]]; then
  BSL_DRY_RUN="$DRY_RUN" bsl_asc_assert_unique_cfbundle_version \
    "$BUNDLE_ID" "$BUNDLE_VERSION" "$BUNDLE_SHORT" || {
    echo "TESTFLIGHT_UPLOAD=fail" >&2
    exit 2
  }
fi
if [[ -n "$KEY_ID" ]]; then
  echo "ASC key id: $KEY_ID"
fi
if [[ -n "$APPLE_ID" ]]; then
  echo "ASC Apple ID: $APPLE_ID"
fi
if [[ -n "${API_PRIVATE_KEYS_DIR:-}" ]]; then
  echo "ASC keys dir: $API_PRIVATE_KEYS_DIR"
  if [[ -n "$KEY_ID" && ! -f "$API_PRIVATE_KEYS_DIR/AuthKey_${KEY_ID}.p8" ]]; then
    echo "Missing $API_PRIVATE_KEYS_DIR/AuthKey_${KEY_ID}.p8" >&2
    echo "Download the .p8 once from App Store Connect → Users and Access → Integrations → App Store Connect API." >&2
    exit 1
  fi
fi

pkg_args() {
  local file="$1"
  PKG_ARGS=(--upload-package "$file" --type "$ALTOOL_TYPE")
  [[ -n "$BUNDLE_ID" ]] && PKG_ARGS+=(--bundle-id "$BUNDLE_ID")
  [[ -n "$BUNDLE_VERSION" ]] && PKG_ARGS+=(--bundle-version "$BUNDLE_VERSION")
  [[ -n "$BUNDLE_SHORT" ]] && PKG_ARGS+=(--bundle-short-version-string "$BUNDLE_SHORT")
  [[ -n "$APPLE_ID" ]] && PKG_ARGS+=(--apple-id "$APPLE_ID")
  PKG_ARGS+=(--show-progress)
}

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN: xcrun altool --validate-app -f $IPA --type $ALTOOL_TYPE --apiKey ${KEY_ID:-KEY} --apiIssuer ${ISSUER_ID:-ISSUER}"
  pkg_args "$IPA"
  echo -n "DRY_RUN: xcrun altool"
  for a in "${PKG_ARGS[@]}"; do
    printf ' %s' "$a"
  done
  echo " --apiKey ${KEY_ID:-KEY} --apiIssuer ${ISSUER_ID:-ISSUER}"
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

if [[ -z "$BUNDLE_ID" || -z "$BUNDLE_VERSION" || -z "$BUNDLE_SHORT" ]]; then
  echo "Could not read CFBundleIdentifier / CFBundleVersion / CFBundleShortVersionString from the IPA." >&2
  echo "Pass --bundle-id / --bundle-version / --bundle-short-version (ITMS-90018 if --upload-package is missing these)." >&2
  exit 1
fi

AUTH=(--apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID")

# Stream altool live into the job log (tee), while keeping a copy for error hints.
LAST_ALTOOL_LOG=""
run_altool() {
  local logfile status
  rm -f "${LAST_ALTOOL_LOG:-}"
  logfile="$(mktemp)"
  LAST_ALTOOL_LOG="$logfile"
  set +e
  # PIPESTATUS[0] is altool; tee almost always exits 0
  xcrun altool "$@" "${AUTH[@]}" 2>&1 | tee "$logfile"
  status=${PIPESTATUS[0]}
  set -e
  # xcrun/altool often exits 0 after printing ERROR: [altool …] (missing --apple-id is 21).
  if grep -qiE 'ERROR:[[:space:]]*\[(altool|ContentDelivery)|Expected apple ID argument is missing' "$logfile"; then
    if [[ "$status" -eq 0 ]]; then
      echo "altool printed ERROR but exited 0 — treating as failure." >&2
      status=1
    fi
  fi
  if [[ "$status" -ne 0 ]]; then
    if grep -qiE 'Expected apple ID argument is missing' "$logfile"; then
      echo "altool --upload-package requires --apple-id (numeric App Store Connect Apple ID). Set BSL_ASC_APPLE_ID." >&2
    elif grep -qiE 'Unable to authenticate|invalid.*key|JWT|401|403|Could not find.*AuthKey' "$logfile"; then
      echo "ASC API auth failed — check BSL_ASC_KEY_ID / ISSUER_ID and AuthKey_${KEY_ID}.p8 (Access: App Manager or Admin)." >&2
    elif grep -qiE 'CFBundleVersion|redundant|already been uploaded|duplicate' "$logfile"; then
      echo "Likely duplicate build number — bump CFBundleVersion in Xcode / agvtool, rebuild, re-upload." >&2
    elif grep -qiE 'No suitable application records|could not find.*app|bundle.*(invalid|mismatch)' "$logfile"; then
      echo "No matching App Store Connect app record for this bundle id — create the app in ASC first." >&2
    elif grep -qiE 'ITMS-90018|extension must be \.zip|file extension must be' "$logfile"; then
      echo "ITMS-90018: Apple rejected the package as a non-zip bundle. Rebuild so archive aliases are copied, and retry --upload-package with bundle metadata." >&2
    fi
  fi
  return "$status"
}

if [[ -z "$APPLE_ID" ]]; then
  echo "Looking up App Store Connect Apple ID for ${BUNDLE_ID}…"
  P8_FILE=""
  if [[ -n "$KEY_PATH" && -f "${KEY_PATH/#\~/$HOME}" ]]; then
    P8_FILE="${KEY_PATH/#\~/$HOME}"
  elif [[ -n "${API_PRIVATE_KEYS_DIR:-}" && -f "$API_PRIVATE_KEYS_DIR/AuthKey_${KEY_ID}.p8" ]]; then
    P8_FILE="$API_PRIVATE_KEYS_DIR/AuthKey_${KEY_ID}.p8"
  fi
  if [[ -n "$P8_FILE" ]]; then
    API_ERR="$(mktemp)"
    APPLE_ID="$(bsl_asc_api_apple_id "$BUNDLE_ID" "$KEY_ID" "$ISSUER_ID" "$P8_FILE" 2>"$API_ERR" | tr -d '[:space:]' || true)"
    if [[ -n "$APPLE_ID" && "$APPLE_ID" =~ ^[0-9]{5,}$ ]]; then
      echo "ASC Apple ID from App Store Connect API: $APPLE_ID"
    else
      APPLE_ID=""
      if [[ -s "$API_ERR" ]]; then
        echo "App Store Connect API Apple ID lookup failed:" >&2
        cat "$API_ERR" >&2
      fi
    fi
    rm -f "$API_ERR"
  fi
fi

if [[ -z "$APPLE_ID" ]]; then
  echo "Trying altool --list-apps for ${BUNDLE_ID}…"
  LIST_OUT="$(mktemp)"
  set +e
  xcrun altool --list-apps --output-format json "${AUTH[@]}" >"$LIST_OUT" 2>&1
  LIST_STATUS=$?
  set -e
  APPLE_ID="$(bsl_apple_id_from_list_apps "$BUNDLE_ID" <"$LIST_OUT" | tr -d '[:space:]' || true)"
  if [[ -n "$APPLE_ID" && ! "$APPLE_ID" =~ ^[0-9]{5,}$ ]]; then
    APPLE_ID=""
  fi
  if [[ -z "$APPLE_ID" ]]; then
    echo "altool --list-apps did not yield an Apple ID for ${BUNDLE_ID} (exit ${LIST_STATUS})." >&2
    if [[ -s "$LIST_OUT" ]]; then
      echo "altool --list-apps snippet:" >&2
      head -c 600 "$LIST_OUT" >&2 || true
      echo >&2
    fi
  fi
  rm -f "$LIST_OUT"
  if [[ -n "$APPLE_ID" ]]; then
    echo "ASC Apple ID from altool --list-apps: $APPLE_ID"
  fi
fi

if [[ -z "$APPLE_ID" ]]; then
  echo "Could not resolve --apple-id for ${BUNDLE_ID}." >&2
  echo "altool --upload-package will not deliver the IPA to TestFlight without it (ERROR 21, often with exit 0)." >&2
  echo "Set BSL_ASC_APPLE_ID to the numeric Apple ID: App Store Connect → your app → App Information → Apple ID." >&2
  echo "TESTFLIGHT_UPLOAD=fail" >&2
  exit 1
fi

if [[ "$SKIP_VALIDATE" != "1" ]]; then
  echo "Validating IPA with altool (catches common rejections before the long upload)…"
  run_altool --validate-app -f "$IPA" --type "$ALTOOL_TYPE"
  echo "Validation OK."
  rm -f "$LAST_ALTOOL_LOG"
fi

echo "Uploading to App Store Connect (keep this Mac awake; Ctrl+C aborts the upload)…"
set +e
pkg_args "$IPA"
run_altool "${PKG_ARGS[@]}"
UPLOAD_STATUS=$?
if [[ "$UPLOAD_STATUS" -ne 0 && -n "$LAST_ALTOOL_LOG" ]] && \
   grep -qiE 'Expected apple ID argument is missing' "$LAST_ALTOOL_LOG"; then
  echo "--upload-package failed: missing --apple-id. Not retrying --upload-app." >&2
elif [[ "$UPLOAD_STATUS" -ne 0 && -n "$LAST_ALTOOL_LOG" ]] && \
   grep -qiE 'ITMS-90018|extension must be \.zip|file extension must be' "$LAST_ALTOOL_LOG"; then
  ZIP="${IPA%.ipa}.zip"
  echo "--upload-package rejected .ipa extension; retrying with $ZIP (IPA is already a zip)…" >&2
  cp "$IPA" "$ZIP"
  pkg_args "$ZIP"
  run_altool "${PKG_ARGS[@]}"
  UPLOAD_STATUS=$?
  rm -f "$ZIP"
fi
if [[ "$UPLOAD_STATUS" -ne 0 ]] && \
   ! grep -qiE 'Expected apple ID argument is missing' "${LAST_ALTOOL_LOG:-/dev/null}"; then
  echo "--upload-package failed (exit $UPLOAD_STATUS); trying legacy --upload-app…" >&2
  run_altool --upload-app -f "$IPA" --type "$ALTOOL_TYPE" --show-progress
  UPLOAD_STATUS=$?
fi
if [[ "$UPLOAD_STATUS" -eq 0 && -n "$LAST_ALTOOL_LOG" ]]; then
  if ! grep -qiE 'UPLOAD SUCCEEDED|No errors uploading|Delivery UUID' "$LAST_ALTOOL_LOG"; then
    echo "altool exited 0 without UPLOAD SUCCEEDED / Delivery UUID — not treating as delivered." >&2
    UPLOAD_STATUS=1
  fi
fi
set -e
if [[ "$UPLOAD_STATUS" -ne 0 ]]; then
  rm -f "$LAST_ALTOOL_LOG"
  echo "Upload failed (exit $UPLOAD_STATUS)." >&2
  echo "TESTFLIGHT_UPLOAD=fail" >&2
  exit "$UPLOAD_STATUS"
fi
rm -f "$LAST_ALTOOL_LOG"

echo "TESTFLIGHT_UPLOAD=ok"
cat <<'EOF'
Upload accepted by App Store Connect.

Next (this is where most “2 hour waits” actually are):
  1. https://appstoreconnect.apple.com → your app → TestFlight → iOS builds
     — do NOT rely only on the TestFlight iPhone app; it hides Processing / Failed builds.
  2. Wait for Processing → Ready to Test (usually minutes; sometimes 1–2h).
  3. If stuck in Processing >2h or Missing Compliance: answer Export Compliance in ASC.
  4. If the build never appears: the upload did not succeed. Re-run and confirm
     TESTFLIGHT_UPLOAD=ok AND no altool ERROR. Missing --apple-id (set BSL_ASC_APPLE_ID)
     used to print ok without delivering the IPA.
  5. Duplicate CFBundleVersion uploads are rejected — bump the build number and retry.
  6. If ASC emails ITMS-90018 (extension must be .zip): the IPA had an aliased
     .app/.appex/.framework. Rebuild on this tooling so archive symlinks are copied
     before export, then bump CFBundleVersion and upload again.
EOF
