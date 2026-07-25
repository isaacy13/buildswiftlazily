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

echo "test-scripts ok"
