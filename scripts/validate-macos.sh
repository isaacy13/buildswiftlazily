#!/usr/bin/env bash
# validate-macos.sh — deeper host checks for first-run confidence (safe to run anywhere;
# skips Xcode-only probes off Darwin).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ok=0
warn=0
fail=0
pass() { echo "  ✓ $*"; ok=$((ok + 1)); }
note() { echo "  ! $*"; warn=$((warn + 1)); }
bad()  { echo "  ✗ $*"; fail=$((fail + 1)); }

echo "== buildswiftlazily validate-macos =="

echo
echo "[scripts executable]"
for s in doctor bootstrap start serve-control serve-ota build-ios install-direct upload-testflight ttl-sweep test-scripts smoke-api validate-macos; do
  if [[ -x "$ROOT/scripts/$s.sh" ]]; then
    pass "scripts/$s.sh"
  else
    bad "scripts/$s.sh not executable"
  fi
done
[[ -f "$ROOT/scripts/lib.sh" ]] && pass "scripts/lib.sh" || bad "scripts/lib.sh missing"

echo
echo "[script CLI / dry-run contracts]"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/proj/Demo.xcodeproj"
echo '// pbx' > "$TMP/proj/Demo.xcodeproj/project.pbxproj"
OUT="$TMP/out"
mkdir -p "$OUT"

# Reject path traversal
if "$ROOT/scripts/build-ios.sh" --root "$TMP/proj" --scheme Demo --project-path '../escape' --out-dir "$OUT" --dry-run >/dev/null 2>&1; then
  bad "build-ios accepted path traversal"
else
  pass "build-ios rejects project-path traversal"
fi

out=$(BSL_DRY_RUN=1 "$ROOT/scripts/build-ios.sh" --root "$TMP/proj" --scheme Demo --out-dir "$OUT" --mode ota --dry-run)
echo "$out" | grep -q 'method=ad-hoc' && pass "ota export method=ad-hoc" || bad "ota export method missing"
echo "$out" | grep -q 'BUILD_OK' && pass "build-ios BUILD_OK" || bad "build-ios BUILD_OK missing"
[[ -f "$OUT/App.ipa" ]] && pass "dry-run writes App.ipa placeholder" || bad "missing App.ipa placeholder"

out=$(BSL_DRY_RUN=1 "$ROOT/scripts/build-ios.sh" --root "$TMP/proj" --scheme Demo --out-dir "$OUT" --mode testflight --dry-run)
echo "$out" | grep -q 'method=app-store' && pass "testflight export method=app-store" || bad "testflight method missing"

echo fake-ipa > "$OUT/App.ipa"
out=$(BSL_DRY_RUN=1 "$ROOT/scripts/serve-ota.sh" --ipa "$OUT/App.ipa" --artifact-id validate1 --title Demo --bundle-id com.demo --bundle-version 1 --ts-host demo.ts.net --dry-run)
echo "$out" | grep -q '^INSTALL_URL=' && pass "serve-ota INSTALL_URL" || bad "serve-ota INSTALL_URL"
echo "$out" | grep -q '^ITMS_URL=itms-services://' && pass "serve-ota ITMS_URL" || bad "serve-ota ITMS_URL"

# Manifest must be valid-ish plist XML with escaped title
ART="${BSL_ARTIFACT_ROOT:-$HOME/buildswiftlazily/artifacts}"
ART="${ART/#\~/$HOME}"
MANIFEST="$ART/www/ota/validate1/manifest.plist"
if [[ -f "$MANIFEST" ]]; then
  grep -q 'com.demo' "$MANIFEST" && pass "manifest contains bundle id" || bad "manifest missing bundle id"
  python3 -c 'import xml.etree.ElementTree as ET; ET.parse("'"$MANIFEST"'")' && pass "manifest is parseable XML" || bad "manifest XML parse failed"
else
  bad "manifest.plist not written"
fi

out=$(BSL_DRY_RUN=1 "$ROOT/scripts/upload-testflight.sh" --ipa "$OUT/App.ipa" --dry-run)
echo "$out" | grep -q TESTFLIGHT_UPLOAD && pass "upload-testflight dry-run" || bad "upload-testflight dry-run"

mkdir -p "$TMP/Demo.app"
echo '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.demo</string></dict></plist>' > "$TMP/Demo.app/Info.plist"
out=$(BSL_DRY_RUN=1 "$ROOT/scripts/install-direct.sh" --app "$TMP/Demo.app" --device deadbeef-device --dry-run)
echo "$out" | grep -q 'devicectl device install' && pass "install-direct dry-run" || bad "install-direct dry-run"

echo
echo "[config templates]"
[[ -f "$ROOT/config/env.example" ]] && pass "env.example" || bad "env.example missing"
[[ -f "$ROOT/config/repos.example.yaml" ]] && pass "repos.example.yaml" || bad "repos.example.yaml missing"
[[ -f "$ROOT/.github/workflows/deploy-ios.yml" ]] && pass "deploy-ios.yml present on this checkout" || bad "deploy-ios.yml missing"
[[ -f "$ROOT/.github/workflows/macos-validate.yml" ]] && pass "macos-validate.yml present" || bad "macos-validate.yml missing"

echo
echo "[darwin probes]"
if [[ "$(uname -s)" == "Darwin" ]]; then
  pass "running on Darwin"
  if xcodebuild -version >/dev/null 2>&1; then
    pass "xcodebuild responds"
  else
    bad "xcodebuild failed"
  fi
  if xcrun --find clang >/dev/null 2>&1; then
    pass "xcrun clang"
  else
    note "xcrun clang not found"
  fi
  if security find-identity -v -p codesigning 2>/dev/null | grep -q 'Apple Development\|Apple Distribution\|iPhone'; then
    pass "at least one Apple codesigning identity"
  else
    note "no Apple Development/Distribution identity yet — first real build will need Xcode signing setup"
  fi
  if xcrun devicectl --help >/dev/null 2>&1; then
    pass "devicectl available"
  else
    note "devicectl missing (Xcode 15+)"
  fi
  # Ensure ExportOptions omits empty teamID (compile-check via dry-run path already covered;
  # also assert the script source doesn't force an empty team string into plist blindly without guard)
  if grep -q 'if \[\[ -n "\$TEAM_ID" \]\]' "$ROOT/scripts/build-ios.sh"; then
    pass "build-ios guards empty TEAM_ID in ExportOptions"
  else
    bad "build-ios should omit empty TEAM_ID from ExportOptions"
  fi
else
  note "not Darwin — skipping Xcode probes (Linux CI OK)"
  # Still enforce the TEAM_ID guard in source on Linux CI
  if grep -q 'if \[\[ -n "\$TEAM_ID" \]\]' "$ROOT/scripts/build-ios.sh"; then
    pass "build-ios guards empty TEAM_ID in ExportOptions"
  else
    bad "build-ios should omit empty TEAM_ID from ExportOptions"
  fi
fi

echo
echo "== summary: $ok ok, $warn warn, $fail fail =="
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
exit 0
