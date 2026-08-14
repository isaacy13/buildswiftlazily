#!/usr/bin/env bash
# check-testflight-version.sh — fail fast if CFBundleVersion is already on ASC
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: check-testflight-version.sh [options]

Confirm CFBundleVersion is new on App Store Connect *before* a long
xcodebuild archive / altool upload. Duplicate build numbers are rejected
by Apple; this check uses the ASC API (same key as TestFlight upload).

Options:
  --root PATH           Xcode checkout (read version from pbxproj / Info.plist)
  --project-path REL    Relative path inside root (default .)
  --scheme NAME         Xcode scheme (helps pick the app target)
  --configuration NAME  Debug|Release (default Release)
  --ipa PATH            Read identity from a built IPA instead of source
  --bundle-id ID        Override CFBundleIdentifier
  --bundle-version VER  Override CFBundleVersion
  --bundle-short-version V  Override CFBundleShortVersionString
  --dry-run             Print identity; do not call App Store Connect
  -h, --help

Auth: BSL_ASC_KEY_ID / BSL_ASC_ISSUER_ID + AuthKey_<id>.p8
Skip: BSL_SKIP_ASC_VERSION_CHECK=1 (or when keys / version cannot be read)

Exit 0 if unique or skipped; exit 2 if the build number already exists.
EOF
}

ROOT=""
PROJECT_PATH="."
SCHEME=""
CONFIGURATION="${BSL_CONFIGURATION:-Release}"
IPA=""
BUNDLE_ID=""
BUNDLE_VERSION=""
BUNDLE_SHORT=""
DRY_RUN="${BSL_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --project-path) PROJECT_PATH="$2"; shift 2 ;;
    --scheme) SCHEME="$2"; shift 2 ;;
    --configuration) CONFIGURATION="$2"; shift 2 ;;
    --ipa) IPA="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --bundle-version) BUNDLE_VERSION="$2"; shift 2 ;;
    --bundle-short-version) BUNDLE_SHORT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage; exit 2 ;;
  esac
done

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_ROOT/scripts/lib.sh"

export BSL_DRY_RUN="$DRY_RUN"

if [[ -n "$SCHEME" && ! "$SCHEME" =~ ^[A-Za-z0-9._+\ -]+$ ]]; then
  echo "Invalid scheme: $SCHEME" >&2
  exit 2
fi
if [[ -n "$CONFIGURATION" && ! "$CONFIGURATION" =~ ^[A-Za-z0-9._+-]+$ ]]; then
  echo "Invalid configuration: $CONFIGURATION" >&2
  exit 2
fi
if [[ "$PROJECT_PATH" == *".."* ]]; then
  echo "Invalid project-path: $PROJECT_PATH" >&2
  exit 2
fi

read_ident() {
  local ident="$1"
  [[ -n "$ident" ]] || return 0
  IFS=$'\t' read -r IPA_BID IPA_VER IPA_SHORT <<<"$ident" || true
  [[ -n "$BUNDLE_ID" ]] || BUNDLE_ID="${IPA_BID:-}"
  [[ -n "$BUNDLE_VERSION" ]] || BUNDLE_VERSION="${IPA_VER:-}"
  [[ -n "$BUNDLE_SHORT" ]] || BUNDLE_SHORT="${IPA_SHORT:-}"
  return 0
}

if [[ -n "$IPA" ]]; then
  [[ -f "$IPA" ]] || { echo "IPA not found: $IPA" >&2; exit 1; }
  read_ident "$(bsl_ipa_bundle_identity "$IPA" || true)"
fi

if [[ -z "$BUNDLE_VERSION" || -z "$BUNDLE_ID" ]] && [[ -n "$ROOT" ]]; then
  [[ -d "$ROOT" ]] || { echo "Checkout not found: $ROOT" >&2; exit 1; }
  ABS_ROOT="$(cd "$ROOT" && pwd)"
  WORK="$ABS_ROOT/$PROJECT_PATH"
  WORK="$(cd "$WORK" && pwd)"
  case "$WORK" in
    "$ABS_ROOT"*) ;;
    *) echo "project-path escapes root" >&2; exit 2 ;;
  esac
  read_ident "$(bsl_source_bundle_identity "$WORK" "$SCHEME" "$CONFIGURATION" || true)"

  # File parse missed $(CURRENT_PROJECT_VERSION) etc. — ask xcodebuild when present.
  if [[ -z "$BUNDLE_VERSION" || -z "$BUNDLE_ID" ]] && command -v xcodebuild >/dev/null 2>&1; then
    WORKSPACE=""
    PROJECT=""
    shopt -s nullglob
    ws=( "$WORK"/*.xcworkspace )
    pj=( "$WORK"/*.xcodeproj )
    shopt -u nullglob
    if [[ ${#ws[@]} -gt 0 ]]; then
      WORKSPACE="${ws[0]}"
    elif [[ ${#pj[@]} -gt 0 ]]; then
      PROJECT="${pj[0]}"
    fi
    if [[ -n "$WORKSPACE" || -n "$PROJECT" ]]; then
      XB_ARGS=( -showBuildSettings -configuration "$CONFIGURATION" )
      [[ -n "$SCHEME" ]] && XB_ARGS+=( -scheme "$SCHEME" )
      if [[ -n "$WORKSPACE" ]]; then
        XB_ARGS+=( -workspace "$WORKSPACE" )
      else
        XB_ARGS+=( -project "$PROJECT" )
      fi
      echo "Reading build settings via xcodebuild (source plist/pbxproj had no version)…"
      set +e
      SETTINGS="$(xcodebuild "${XB_ARGS[@]}" 2>/dev/null)"
      XB_ST=$?
      set -e
      if [[ "$XB_ST" -eq 0 && -n "$SETTINGS" ]]; then
        xb_val() {
          printf '%s\n' "$SETTINGS" | awk -F' = ' -v k="$1" '
            $1 ~ k { sub(/^[ \t]+/, "", $1); if ($1==k) { print $2; exit } }'
        }
        [[ -n "$BUNDLE_ID" ]] || BUNDLE_ID="$(xb_val PRODUCT_BUNDLE_IDENTIFIER | tr -d '\r')"
        [[ -n "$BUNDLE_VERSION" ]] || BUNDLE_VERSION="$(xb_val CURRENT_PROJECT_VERSION | tr -d '\r')"
        [[ -n "$BUNDLE_SHORT" ]] || BUNDLE_SHORT="$(xb_val MARKETING_VERSION | tr -d '\r')"
      fi
    fi
  fi
fi

if [[ -n "$BUNDLE_ID" ]]; then
  echo "Bundle id: $BUNDLE_ID"
fi
if [[ -n "$BUNDLE_VERSION" ]]; then
  echo "CFBundleVersion: $BUNDLE_VERSION"
fi
if [[ -n "$BUNDLE_SHORT" ]]; then
  echo "CFBundleShortVersionString: $BUNDLE_SHORT"
fi

if [[ -z "$BUNDLE_ID" || -z "$BUNDLE_VERSION" ]]; then
  echo "Could not read CFBundleIdentifier / CFBundleVersion from source or IPA."
  echo "TESTFLIGHT_VERSION_CHECK=skip (identity unknown — upload will re-check the IPA)"
  exit 0
fi

bsl_asc_assert_unique_cfbundle_version "$BUNDLE_ID" "$BUNDLE_VERSION" "$BUNDLE_SHORT"
