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
echo "$out1" | grep -q 'derivedDataPath'
echo "$out1" | grep -q 'ENABLE_USER_SCRIPT_SANDBOXING=NO'

out2=$(BSL_DRY_RUN=1 "$ROOT/scripts/build-ios.sh" --root "$TMP/proj" --scheme Demo --out-dir "$OUT" --mode ota --dry-run)
echo "$out2" | grep -q 'method=ad-hoc'
echo "$out2" | grep -q 'platform=ios'

out2b=$(BSL_DRY_RUN=1 "$ROOT/scripts/build-ios.sh" --root "$TMP/proj" --scheme Demo --out-dir "$OUT" --mode ota --platform watchos --dry-run)
echo "$out2b" | grep -q 'generic/platform=watchOS'
echo "$out2b" | grep -q 'platform=watchos'

echo fake > "$OUT/App.ipa"
out3=$(BSL_DRY_RUN=1 "$ROOT/scripts/upload-testflight.sh" --ipa "$OUT/App.ipa" --dry-run)
echo "$out3" | grep -q TESTFLIGHT_UPLOAD
echo "$out3" | grep -q 'upload-package'

out4=$(BSL_DRY_RUN=1 "$ROOT/scripts/serve-ota.sh" --ipa "$OUT/App.ipa" --artifact-id scripttest1 --title Demo --bundle-id com.demo --ts-host x.ts.net --dry-run)
echo "$out4" | grep -q INSTALL_URL

mkdir -p "$TMP/Demo.app"
printf '%s\n' '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.demo</string></dict></plist>' > "$TMP/Demo.app/Info.plist"
out5=$(BSL_DRY_RUN=1 "$ROOT/scripts/install-direct.sh" --app "$TMP/Demo.app" --device test-device --dry-run)
echo "$out5" | grep -q 'devicectl device install'

out5b=$(BSL_DRY_RUN=1 "$ROOT/scripts/install-direct.sh" --app "$TMP/Demo.app" --device test-device --device-class watch --dry-run)
echo "$out5b" | grep -q 'class=watch'

# Embed Foundation Extensions build-phase reorder (Xcode 15+ archive helper)
mkdir -p "$TMP/embed/App.xcodeproj"
cat > "$TMP/embed/App.xcodeproj/project.pbxproj" <<'PBX'
// !$*UTF8*$!
{
	objects = {
		AAAAAAAA0000000000000001 /* RemoteInfo */ = { isa = PBXNativeTarget; buildPhases = (
				BB0000000000000000000001 /* Sources */,
				BB0000000000000000000002 /* Frameworks */,
				BB0000000000000000000003 /* Resources */,
				BB0000000000000000000005 /* Thin Binary */,
				BB0000000000000000000004 /* Embed Foundation Extensions */,
			); };
	};
	rootObject = ROOT;
}
PBX
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
fix_out=$(bsl_fix_embed_extension_phases "$TMP/embed")
echo "$fix_out" | grep -q 'Reordered Embed Foundation'
python3 - "$TMP/embed/App.xcodeproj/project.pbxproj" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
ids = re.findall(r"/\*\s*(.*?)\s*\*/", text.split("buildPhases")[1].split(");")[0])
assert ids.index("Embed Foundation Extensions") < ids.index("Thin Binary"), ids
print("embed-order ok")
PY

# Deeper contract checks (path safety, manifest XML, TEAM_ID guard, etc.)
"$ROOT/scripts/validate-macos.sh" >/dev/null

echo "test-scripts ok"
