#!/usr/bin/env bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/proj/Demo.xcodeproj"
echo x > "$TMP/proj/Demo.xcodeproj/project.pbxproj"
OUT="$TMP/out"
mkdir -p "$OUT"

out1=$(BSL_DRY_RUN=1 "$ROOT/scripts/build-ios.sh" --root "$TMP/proj" --scheme Demo --out-dir "$OUT" --mode testflight --dry-run)
echo "$out1" | grep -q 'method=app-store'

out2=$(BSL_DRY_RUN=1 "$ROOT/scripts/build-ios.sh" --root "$TMP/proj" --scheme Demo --out-dir "$OUT" --mode ota --dry-run)
echo "$out2" | grep -q 'method=ad-hoc'

echo fake > "$OUT/App.ipa"
out3=$(BSL_DRY_RUN=1 "$ROOT/scripts/upload-testflight.sh" --ipa "$OUT/App.ipa" --dry-run)
echo "$out3" | grep -q TESTFLIGHT_UPLOAD

out4=$(BSL_DRY_RUN=1 "$ROOT/scripts/serve-ota.sh" --ipa "$OUT/App.ipa" --artifact-id scripttest1 --title Demo --bundle-id com.demo --ts-host x.ts.net --dry-run)
echo "$out4" | grep -q INSTALL_URL

mkdir -p "$TMP/Demo.app"
printf '%s\n' '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.demo</string></dict></plist>' > "$TMP/Demo.app/Info.plist"
out5=$(BSL_DRY_RUN=1 "$ROOT/scripts/install-direct.sh" --app "$TMP/Demo.app" --device test-device --dry-run)
echo "$out5" | grep -q 'devicectl device install'

# Deeper contract checks (path safety, manifest XML, TEAM_ID guard, etc.)
"$ROOT/scripts/validate-macos.sh" >/dev/null

echo "test-scripts ok"
