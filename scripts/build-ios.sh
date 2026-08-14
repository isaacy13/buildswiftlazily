#!/usr/bin/env bash
# build-ios.sh — archive + export Ad Hoc IPA (and/or .app for direct install)
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-ios.sh --root <checkout> --scheme <name> [options]

Options:
  --root PATH           Path to Xcode project checkout (required)
  --scheme NAME         Xcode scheme (required)
  --project-path REL    Relative path inside root to .xcodeproj/.xcworkspace dir (default .)
  --configuration NAME  Debug|Release (default Release)
  --platform ios|watchos  Archive destination platform (default ios)
  --team-id ID          Apple Team ID (or BSL_TEAM_ID)
  --bundle-id ID        Override bundle id for ExportOptions (optional)
  --out-dir PATH        Output directory for IPA/app (required)
  --mode ota|direct|both|testflight  Default: both
  --dry-run             Print actions only
EOF
}

ROOT=""
SCHEME=""
PROJECT_PATH="."
CONFIGURATION="${BSL_CONFIGURATION:-Release}"
PLATFORM="${BSL_PLATFORM:-ios}"
TEAM_ID="${BSL_TEAM_ID:-}"
BUNDLE_ID=""
OUT_DIR=""
MODE="both"
DRY_RUN="${BSL_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --scheme) SCHEME="$2"; shift 2 ;;
    --project-path) PROJECT_PATH="$2"; shift 2 ;;
    --configuration) CONFIGURATION="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --team-id) TEAM_ID="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$ROOT" && -n "$SCHEME" && -n "$OUT_DIR" ]] || { usage; exit 2; }

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_ROOT/scripts/lib.sh"

# Path safety: reject .. and absolute sneaking in project-path
if [[ "$PROJECT_PATH" == *".."* ]]; then
  echo "Invalid project-path: $PROJECT_PATH" >&2
  exit 2
fi
# Scheme / configuration must be shell-safe (no metacharacters)
if [[ ! "$SCHEME" =~ ^[A-Za-z0-9._+\ -]+$ ]]; then
  echo "Invalid scheme: $SCHEME" >&2
  exit 2
fi
if [[ ! "$CONFIGURATION" =~ ^[A-Za-z0-9._+-]+$ ]]; then
  echo "Invalid configuration: $CONFIGURATION" >&2
  exit 2
fi
PLATFORM="$(printf '%s' "$PLATFORM" | tr '[:upper:]' '[:lower:]')"
if [[ "$PLATFORM" != "ios" && "$PLATFORM" != "watchos" ]]; then
  echo "Invalid platform (expected ios or watchos): $PLATFORM" >&2
  exit 2
fi
if [[ -n "$TEAM_ID" && ! "$TEAM_ID" =~ ^[A-Za-z0-9]{10}$ ]]; then
  echo "Invalid team-id (expected 10 alphanumeric chars)" >&2
  exit 2
fi

ABS_ROOT="$(cd "$ROOT" && pwd)"
WORK="$ABS_ROOT/$PROJECT_PATH"
WORK="$(cd "$WORK" && pwd)"
case "$WORK" in
  "$ABS_ROOT"*) ;;
  *) echo "project-path escapes root" >&2; exit 2 ;;
esac

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY_RUN: $*"
  else
    "$@"
  fi
}

# Discover workspace or project
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
else
  # search one level deeper for monorepos
  shopt -s nullglob
  ws=( "$WORK"/*/*.xcworkspace )
  pj=( "$WORK"/*/*.xcodeproj )
  shopt -u nullglob
  if [[ ${#ws[@]} -gt 0 ]]; then
    WORKSPACE="${ws[0]}"
  elif [[ ${#pj[@]} -gt 0 ]]; then
    PROJECT="${pj[0]}"
  else
    echo "No .xcworkspace/.xcodeproj under $WORK" >&2
    exit 1
  fi
fi

ARCHIVE_PATH="$OUT_DIR/App.xcarchive"
EXPORT_DIR="$OUT_DIR/export"
APP_DIR="$OUT_DIR/app"
DERIVED_DATA="$OUT_DIR/DerivedData"
rm -rf "$EXPORT_DIR" "$APP_DIR" "$DERIVED_DATA"
mkdir -p "$EXPORT_DIR" "$APP_DIR" "$DERIVED_DATA"

XCODE_DEST="generic/platform=iOS"
if [[ "$PLATFORM" == "watchos" ]]; then
  XCODE_DEST="generic/platform=watchOS"
fi

XCODE_ARGS=( -scheme "$SCHEME" -configuration "$CONFIGURATION" -destination "$XCODE_DEST" -archivePath "$ARCHIVE_PATH" -derivedDataPath "$DERIVED_DATA" )
if [[ -n "$WORKSPACE" ]]; then
  XCODE_ARGS=( -workspace "$WORKSPACE" "${XCODE_ARGS[@]}" )
else
  XCODE_ARGS=( -project "$PROJECT" "${XCODE_ARGS[@]}" )
fi

echo "Building archive (platform=$PLATFORM destination=$XCODE_DEST)…"
echo "xcodebuild can take 10–40+ minutes with little output — heartbeats will keep ticking."
# Prefer automatic signing updates on personal Mac runner
if [[ "$DRY_RUN" != "1" ]]; then
  HAD_KC_PASS=0
  [[ -n "${BSL_KEYCHAIN_PASSWORD:-}" ]] && HAD_KC_PASS=1
  if ! bsl_unlock_keychain_for_build; then
    echo "Could not unlock login keychain (BSL_KEYCHAIN_PASSWORD wrong or keychain missing)." >&2
    echo "Run ./scripts/prepare-keychain.sh on the Mac, or fix BSL_KEYCHAIN_PASSWORD." >&2
    # Fail closed when the operator explicitly configured a password for unattended unlock.
    if [[ "$HAD_KC_PASS" == "1" ]]; then
      exit 1
    fi
  fi
  # Defense in depth if unlock was a no-op path
  unset BSL_KEYCHAIN_PASSWORD || true
fi

# Reorder Embed Foundation/App Extensions after Resources / before Thin Binary,
# and disable user-script sandboxing so embed/CocoaPods scripts can codesign.
# Fresh tarball checkouts inherit whatever the app repo committed.
if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN: would fix Embed Foundation Extensions build phase order under $ABS_ROOT"
  echo "DRY_RUN: would disable ENABLE_USER_SCRIPT_SANDBOXING=YES in pbxproj under $ABS_ROOT"
else
  bsl_fix_embed_extension_phases "$ABS_ROOT" || true
  bsl_disable_user_script_sandboxing "$ABS_ROOT" || true
fi

ARCHIVE_LOG="$OUT_DIR/xcodebuild-archive.log"
ARCHIVE_CMD=(
  xcodebuild "${XCODE_ARGS[@]}"
  -allowProvisioningUpdates
  clean archive
  # Per-job DerivedData above already isolates state; disable script sandbox so
  # CocoaPods / Flutter / extension embed scripts can codesign + rsync.
  ENABLE_USER_SCRIPT_SANDBOXING=NO
)
if [[ -n "$TEAM_ID" ]]; then
  ARCHIVE_CMD+=( DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic )
fi
echo "Running: ${ARCHIVE_CMD[*]}"
set +e
set +o pipefail
if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN: ${ARCHIVE_CMD[*]}"
  ARCHIVE_STATUS=0
else
  "${ARCHIVE_CMD[@]}" 2>&1 | tee "$ARCHIVE_LOG"
  ARCHIVE_STATUS=${PIPESTATUS[0]}
fi
set -e
set -o pipefail
if [[ "$ARCHIVE_STATUS" -ne 0 ]]; then
  echo "Archive failed (exit=$ARCHIVE_STATUS)." >&2
  if [[ -f "$ARCHIVE_LOG" ]]; then
    echo "---- xcodebuild errors ----" >&2
    grep -E 'error:|fatal error:|\*\* ARCHIVE FAILED \*\*|The following build commands failed:' "$ARCHIVE_LOG" | tail -n 50 >&2 || true
  fi
  # Only hint embed-phase fixes when that phase is in the failed-commands list
  # (DerivedData / the build transcript always mention the phase if the app has extensions).
  if [[ -f "$ARCHIVE_LOG" ]]; then
    failed_cmds=$(awk '/The following build commands failed:/,/^$/' "$ARCHIVE_LOG" || true)
    if echo "$failed_cmds" | grep -Eqi 'Embed (Foundation|App|ExtensionKit) Extensions|Embed Watch Content|\.appex' \
      || grep -Eqi 'error:.*Embed (Foundation|App|ExtensionKit) Extensions' "$ARCHIVE_LOG"; then
      echo "Hint: Embed Foundation/App Extensions failed. Common fixes:" >&2
      echo "  1) In Xcode → Target → Build Phases, drag Embed Foundation Extensions to just after Resources and above Thin Binary / Run Script phases." >&2
      echo "  2) Ensure every app extension target signs with the same Team (automatic) and archives with the app scheme." >&2
      echo "  3) Run ./scripts/prepare-keychain.sh if codesign is blocked (errSecInteractionNotAllowed)." >&2
    fi
  fi
  exit "$ARCHIVE_STATUS"
fi
echo "Archive step finished."

# Replace bundle-like symlinks in the archive so exportArchive ships real
# .app/.appex/.framework copies. Aliases here become ITMS-90018 after upload.
if [[ "$DRY_RUN" != "1" && -d "$ARCHIVE_PATH/Products/Applications" ]]; then
  bsl_materialize_bundle_symlinks "$ARCHIVE_PATH/Products/Applications"
fi

# Locate .app inside archive for direct install
if [[ "$MODE" == "direct" || "$MODE" == "both" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY_RUN: copy .app from archive to $APP_DIR"
  else
    APP_SRC="$(find "$ARCHIVE_PATH/Products/Applications" -maxdepth 1 -name '*.app' | head -1)"
    if [[ -z "$APP_SRC" ]]; then
      echo "No .app in archive" >&2
      exit 1
    fi
    cp -R "$APP_SRC" "$APP_DIR/"
    echo "APP_PATH=$APP_DIR/$(basename "$APP_SRC")" | tee "$OUT_DIR/app_path.txt"
  fi
fi

export_ipa() {
  local method="$1"
  local EXPORT_PLIST="$OUT_DIR/ExportOptions.plist"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY_RUN: write ExportOptions.plist method=$method && exportArchive"
    : > "$OUT_DIR/App.ipa"
    echo "IPA_PATH=$OUT_DIR/App.ipa"
    return 0
  fi
  # Empty teamID in ExportOptions breaks first-run exports — omit until set.
  if [[ -n "$TEAM_ID" ]]; then
    TEAM_XML=$'\n  <key>teamID</key>\n  <string>'"${TEAM_ID}"$'</string>'
  else
    TEAM_XML=""
    echo "Warning: BSL_TEAM_ID unset — relying on Xcode automatic signing defaults" >&2
  fi
  cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${method}</string>
  <key>signingStyle</key>
  <string>automatic</string>${TEAM_XML}
  <key>compileBitcode</key>
  <false/>
  <key>stripSwiftSymbols</key>
  <true/>
  <key>destination</key>
  <string>export</string>
</dict>
</plist>
EOF
  rm -rf "$EXPORT_DIR"
  mkdir -p "$EXPORT_DIR"
  run xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_PLIST" \
    -allowProvisioningUpdates
  IPA="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.ipa' | head -1)"
  if [[ -z "$IPA" ]]; then
    echo "Export produced no IPA" >&2
    exit 1
  fi
  cp "$IPA" "$OUT_DIR/App.ipa"
  echo "IPA_PATH=$OUT_DIR/App.ipa" | tee "$OUT_DIR/ipa_path.txt"
  bsl_assert_ipa_payload "$OUT_DIR/App.ipa"

  if command -v unzip >/dev/null 2>&1; then
    TMP="$(mktemp -d)"
    unzip -q -o "$OUT_DIR/App.ipa" -d "$TMP" 'Payload/*.app/Info.plist' || true
    PLIST="$(find "$TMP/Payload" -name Info.plist | head -1 || true)"
    if [[ -n "$PLIST" && -x /usr/libexec/PlistBuddy ]]; then
      /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST" > "$OUT_DIR/bundle_id.txt" || true
      /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST" > "$OUT_DIR/bundle_version.txt" || true
      /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" > "$OUT_DIR/bundle_short_version.txt" || true
      /usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$PLIST" > "$OUT_DIR/bundle_name.txt" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$PLIST" > "$OUT_DIR/bundle_name.txt" || true
    fi
    rm -rf "$TMP"
  fi
}

if [[ "$MODE" == "ota" || "$MODE" == "both" ]]; then
  export_ipa "ad-hoc"
fi

if [[ "$MODE" == "testflight" ]]; then
  # App Store / TestFlight distribution signing
  export_ipa "app-store"
fi

echo "BUILD_OK out=$OUT_DIR mode=$MODE platform=$PLATFORM"
