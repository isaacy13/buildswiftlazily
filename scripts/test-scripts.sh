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

# Mini IPA (real zip + Info.plist) so upload-package gets required bundle metadata
python3 - "$TMP/mini.ipa" <<'PY'
import plistlib, sys, zipfile
from pathlib import Path
ipa = Path(sys.argv[1])
info = {
    "CFBundleIdentifier": "com.demo.app",
    "CFBundleVersion": "42",
    "CFBundleShortVersionString": "1.2.3",
}
buf = plistlib.dumps(info)
with zipfile.ZipFile(ipa, "w") as z:
    z.writestr("Payload/Demo.app/Info.plist", buf)
PY
out3b=$(BSL_DRY_RUN=1 "$ROOT/scripts/upload-testflight.sh" --ipa "$TMP/mini.ipa" --dry-run)
echo "$out3b" | grep -q -- '--bundle-id com.demo.app'
echo "$out3b" | grep -q -- '--bundle-version 42'
echo "$out3b" | grep -q -- '--bundle-short-version-string 1.2.3'

# ITMS-90018 helpers: materialize archive aliases; reject non-zip / symlink bundles
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
mkdir -p "$TMP/arch/Demo.app" "$TMP/real.appex"
echo plugin > "$TMP/real.appex/Info.plist"
ln -s "$TMP/real.appex" "$TMP/arch/Demo.app/PlugIn.appex"
fix_sy=$(bsl_materialize_bundle_symlinks "$TMP/arch")
echo "$fix_sy" | grep -q 'Materialized'
test -d "$TMP/arch/Demo.app/PlugIn.appex"
test ! -L "$TMP/arch/Demo.app/PlugIn.appex"
grep -q plugin "$TMP/arch/Demo.app/PlugIn.appex/Info.plist"
ident=$(bsl_ipa_bundle_identity "$TMP/mini.ipa")
echo "$ident" | grep -q $'com.demo.app\t42\t1.2.3'
aid=$(printf '%s\n' '{"applications":[{"bundleID":"com.demo.app","appleId":1234567890}]}' | bsl_apple_id_from_list_apps com.demo.app)
test "$aid" = "1234567890"
if bsl_assert_ipa_payload "$OUT/App.ipa" >/dev/null 2>&1; then
  echo "expected non-zip IPA to fail payload check" >&2
  exit 1
fi
bsl_assert_ipa_payload "$TMP/mini.ipa" >/dev/null

python3 - "$TMP/symlink.ipa" <<'PY'
import plistlib, sys, zipfile
from pathlib import Path
ipa = Path(sys.argv[1])
info = plistlib.dumps({"CFBundleIdentifier": "com.demo.app"})
with zipfile.ZipFile(ipa, "w") as z:
    z.writestr("Payload/Demo.app/Info.plist", info)
    zi = zipfile.ZipInfo("Payload/Demo.app/Bad.framework")
    zi.create_system = 3
    zi.external_attr = 0o120777 << 16
    z.writestr(zi, "/tmp/missing.framework")
PY
if bsl_assert_ipa_payload "$TMP/symlink.ipa" >/dev/null 2>&1; then
  echo "expected symlink-bundle IPA to fail" >&2
  exit 1
fi

out4=$(BSL_DRY_RUN=1 "$ROOT/scripts/serve-ota.sh" --ipa "$OUT/App.ipa" --artifact-id scripttest1 --title Demo --bundle-id com.demo --ts-host x.ts.net --dry-run)
echo "$out4" | grep -q INSTALL_URL

mkdir -p "$TMP/Demo.app"
printf '%s\n' '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.demo</string></dict></plist>' > "$TMP/Demo.app/Info.plist"
out5=$(BSL_DRY_RUN=1 "$ROOT/scripts/install-direct.sh" --app "$TMP/Demo.app" --device test-device --dry-run)
echo "$out5" | grep -q 'devicectl device install'

out5b=$(BSL_DRY_RUN=1 "$ROOT/scripts/install-direct.sh" --app "$TMP/Demo.app" --device test-device --device-class watch --dry-run)
echo "$out5b" | grep -q 'class=watch'

# Embed Foundation Extensions: after Resources, before Thin Binary (not first).
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
assert ids == [
    "Sources",
    "Frameworks",
    "Resources",
    "Embed Foundation Extensions",
    "Thin Binary",
], ids
print("embed-order ok")
PY

# Previous helper put Embed first; that must be corrected too.
mkdir -p "$TMP/embed-front/App.xcodeproj"
cat > "$TMP/embed-front/App.xcodeproj/project.pbxproj" <<'PBX'
// !$*UTF8*$!
{
	objects = {
		AAAAAAAA0000000000000001 /* RemoteInfo */ = { isa = PBXNativeTarget; buildPhases = (
				BB0000000000000000000004 /* Embed Foundation Extensions */,
				BB0000000000000000000001 /* Sources */,
				BB0000000000000000000002 /* Frameworks */,
				BB0000000000000000000003 /* Resources */,
				BB0000000000000000000005 /* Thin Binary */,
			); };
	};
	rootObject = ROOT;
}
PBX
fix_front=$(bsl_fix_embed_extension_phases "$TMP/embed-front")
echo "$fix_front" | grep -q 'Reordered Embed Foundation'
python3 - "$TMP/embed-front/App.xcodeproj/project.pbxproj" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
ids = re.findall(r"/\*\s*(.*?)\s*\*/", text.split("buildPhases")[1].split(");")[0])
assert ids.index("Sources") < ids.index("Embed Foundation Extensions")
assert ids.index("Resources") < ids.index("Embed Foundation Extensions")
assert ids.index("Embed Foundation Extensions") < ids.index("Thin Binary")
print("embed-front-corrected ok")
PY

# CocoaPods: keep Check Pods Manifest.lock first; embed still before Thin Binary / [CP] scripts.
mkdir -p "$TMP/embed-pods/App.xcodeproj"
cat > "$TMP/embed-pods/App.xcodeproj/project.pbxproj" <<'PBX'
// !$*UTF8*$!
{
	objects = {
		AAAAAAAA0000000000000001 /* RemoteInfo */ = { isa = PBXNativeTarget; buildPhases = (
				BB0000000000000000000000 /* [CP] Check Pods Manifest.lock */,
				BB0000000000000000000001 /* Sources */,
				BB0000000000000000000002 /* Frameworks */,
				BB0000000000000000000003 /* Resources */,
				BB0000000000000000000006 /* [CP] Embed Pods Frameworks */,
				BB0000000000000000000005 /* Thin Binary */,
				BB0000000000000000000004 /* Embed App Extensions */,
			); };
	};
	rootObject = ROOT;
}
PBX
fix_pods=$(bsl_fix_embed_extension_phases "$TMP/embed-pods")
echo "$fix_pods" | grep -q 'Reordered Embed Foundation'
python3 - "$TMP/embed-pods/App.xcodeproj/project.pbxproj" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
ids = re.findall(r"/\*\s*(.*?)\s*\*/", text.split("buildPhases")[1].split(");")[0])
assert ids[0] == "[CP] Check Pods Manifest.lock", ids
assert ids.index("Resources") < ids.index("Embed App Extensions")
assert ids.index("Embed App Extensions") < ids.index("Thin Binary")
assert ids.index("Embed App Extensions") < ids.index("[CP] Embed Pods Frameworks")
print("embed-pods-order ok")
PY

mkdir -p "$TMP/sandbox/App.xcodeproj"
cat > "$TMP/sandbox/App.xcodeproj/project.pbxproj" <<'PBX'
ENABLE_USER_SCRIPT_SANDBOXING = YES;
OTHER = 1;
ENABLE_USER_SCRIPT_SANDBOXING = YES;
PBX
sb_out=$(bsl_disable_user_script_sandboxing "$TMP/sandbox")
echo "$sb_out" | grep -q 'Disabled ENABLE_USER_SCRIPT_SANDBOXING'
grep -q 'ENABLE_USER_SCRIPT_SANDBOXING = NO' "$TMP/sandbox/App.xcodeproj/project.pbxproj"
if grep -q 'ENABLE_USER_SCRIPT_SANDBOXING = YES' "$TMP/sandbox/App.xcodeproj/project.pbxproj"; then
  echo "sandbox YES leftover" >&2
  exit 1
fi

# Deeper contract checks (path safety, manifest XML, TEAM_ID guard, etc.)
"$ROOT/scripts/validate-macos.sh" >/dev/null

echo "test-scripts ok"
