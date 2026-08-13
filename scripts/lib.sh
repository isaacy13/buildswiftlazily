#!/usr/bin/env bash
# Shared helpers for buildswiftlazily scripts (source me).

bsl_find_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return 0
  fi
  local candidates=(
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    "/usr/local/bin/tailscale"
    "/opt/homebrew/bin/tailscale"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

bsl_tailscale() {
  local bin
  bin="$(bsl_find_tailscale)" || return 127
  "$bin" "$@"
}

bsl_guess_team_ids() {
  # Print unique 10-char team IDs seen in codesigning identity names.
  security find-identity -v -p codesigning 2>/dev/null \
    | python3 -c '
import re, sys
seen=set()
for line in sys.stdin:
    for m in re.finditer(r"\(([A-Z0-9]{10})\)", line):
        tid=m.group(1)
        if tid not in seen:
            seen.add(tid)
            print(tid)
' 2>/dev/null || true
}

bsl_login_keychain_path() {
  # Prefer the modern -db path; fall back to legacy name.
  local home="${HOME:-}"
  if [[ -f "$home/Library/Keychains/login.keychain-db" ]]; then
    printf '%s\n' "$home/Library/Keychains/login.keychain-db"
  elif [[ -f "$home/Library/Keychains/login.keychain" ]]; then
    printf '%s\n' "$home/Library/Keychains/login.keychain"
  else
    # Default path even if not yet created — security will error clearly.
    printf '%s\n' "$home/Library/Keychains/login.keychain-db"
  fi
}

bsl_keychain_prepared_marker() {
  printf '%s\n' "${BSL_KEYCHAIN_PREPARED_MARKER:-$HOME/.config/buildswiftlazily/keychain-prepared}"
}

# Unlock login keychain for unattended xcodebuild/codesign.
# Uses BSL_KEYCHAIN_PASSWORD when set. No-ops (exit 0) when unset so interactive
# GUI sessions that already hold an unlocked keychain keep working.
# On success, unsets BSL_KEYCHAIN_PASSWORD in this shell so child processes
# (xcodebuild / Run Script phases) do not inherit the login password.
bsl_unlock_keychain_for_build() {
  local pass="${BSL_KEYCHAIN_PASSWORD:-}"
  local keychain
  keychain="$(bsl_login_keychain_path)"
  if [[ -z "$pass" ]]; then
    return 0
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    unset BSL_KEYCHAIN_PASSWORD || true
    return 0
  fi
  if ! security unlock-keychain -p "$pass" "$keychain" >/dev/null; then
    unset BSL_KEYCHAIN_PASSWORD || true
    return 1
  fi
  unset BSL_KEYCHAIN_PASSWORD || true
  return 0
}

# Move "Embed Foundation Extensions" / "Embed App Extensions" earlier in each
# target's buildPhases list (after [CP] Check Pods Manifest.lock when present).
# Fixes common Xcode 15+ archive failures when Thin Binary / CocoaPods scripts
# run before extensions are embedded. Safe no-op when no matching phase exists.
bsl_fix_embed_extension_phases() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  python3 - "$root" <<'PY'
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
embed_re = re.compile(r"Embed (?:Foundation|App) Extensions", re.I)
keep_front_re = re.compile(r"\[CP\] Check Pods Manifest\.lock", re.I)
phase_line_re = re.compile(
    r"^(\s*)([A-F0-9]{24})\s*/\*\s*(.*?)\s*\*/\s*,\s*$"
)

changed_files = 0
for pbx in root.rglob("project.pbxproj"):
    parts_l = {x.lower() for x in pbx.parts}
    if "pods" in parts_l or ".build" in parts_l or "sourcedpackages" in parts_l:
        continue
    original = pbx.read_text(encoding="utf-8", errors="replace")
    out = []
    i = 0
    lines = original.splitlines(keepends=True)
    file_changed = False
    while i < len(lines):
        line = lines[i]
        if re.search(r"\bbuildPhases\s*=\s*\(", line):
            block = [line]
            i += 1
            while i < len(lines):
                block.append(lines[i])
                if lines[i].lstrip().startswith(");"):
                    i += 1
                    break
                i += 1
            body_idxs = []
            for bi, bl in enumerate(block):
                m = phase_line_re.match(bl.rstrip("\n"))
                if m:
                    body_idxs.append((bi, m.group(1), m.group(2), m.group(3)))
            embeds = [t for t in body_idxs if embed_re.search(t[3])]
            if embeds:
                front = [t for t in body_idxs if keep_front_re.search(t[3])]
                rest = [
                    t
                    for t in body_idxs
                    if t not in embeds and t not in front
                ]
                new_order = front + embeds + rest
                if [t[2] for t in new_order] != [t[2] for t in body_idxs]:
                    # Rewrite only the ID lines; keep the opening/closing lines.
                    id_bis = {t[0] for t in body_idxs}
                    new_block = []
                    order_iter = iter(new_order)
                    for bi, bl in enumerate(block):
                        if bi in id_bis:
                            _bi, indent, pid, name = next(order_iter)
                            new_block.append(f"{indent}{pid} /* {name} */,\n")
                        else:
                            new_block.append(bl)
                    block = new_block
                    file_changed = True
            out.extend(block)
            continue
        out.append(line)
        i += 1
    if file_changed:
        pbx.write_text("".join(out), encoding="utf-8")
        changed_files += 1
        print(f"Reordered Embed Foundation/App Extensions in {pbx}")

if changed_files == 0:
    print("No Embed Foundation/App Extensions phase reorder needed")
PY
}

# Apple ITMS-90018 ("The file extension must be .zip") is the processing email
# you get when a "bundle" inside the IPA (.app / .appex / .framework / .bundle)
# is a symlink (often to DerivedData) instead of a real copy. Materialize those
# in the xcarchive before exportArchive re-signs.
bsl_materialize_bundle_symlinks() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  python3 - "$root" <<'PY'
import os, pathlib, shutil, sys

root = pathlib.Path(sys.argv[1])
suffixes = (".app", ".appex", ".framework", ".bundle", ".xpc")

def is_bundle_like(path: pathlib.Path) -> bool:
    name = path.name.lower()
    return any(name.endswith(s) for s in suffixes)

found = []
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    base = pathlib.Path(dirpath)
    # Do not walk through symlink dirs; we will replace them in-place.
    keep = []
    for d in dirnames:
        p = base / d
        if p.is_symlink() and is_bundle_like(p):
            found.append(p)
        elif not p.is_symlink():
            keep.append(d)
    dirnames[:] = keep
    for name in filenames:
        p = base / name
        if p.is_symlink() and is_bundle_like(p):
            found.append(p)

found.sort(key=lambda p: len(p.parts), reverse=True)
fixed = 0
for link in found:
    raw = os.readlink(link)
    target = (link.parent / raw).resolve() if not os.path.isabs(raw) else pathlib.Path(raw)
    if not target.exists():
        print(
            f"Dangling bundle symlink (ITMS-90018): {link} -> {raw}",
            file=sys.stderr,
        )
        sys.exit(2)
    tmp = link.with_name(link.name + ".bsl-real")
    if tmp.exists():
        shutil.rmtree(tmp) if tmp.is_dir() and not tmp.is_symlink() else tmp.unlink()
    if target.is_dir():
        shutil.copytree(target, tmp, symlinks=False)
    else:
        shutil.copy2(target, tmp)
    link.unlink()
    tmp.rename(link)
    print(f"Materialized bundle symlink {link} <- {target}")
    fixed += 1

if fixed:
    print(f"Materialized {fixed} bundle symlink(s) before App Store export")
else:
    print("No bundle symlinks to materialize")
PY
}

# Confirm an IPA is a zip with Payload/*.app and no leftover bundle-like
# symlinks (signed IPAs must not be rewritten).
bsl_assert_ipa_payload() {
  local ipa="$1"
  [[ -f "$ipa" ]] || { echo "IPA not found: $ipa" >&2; return 1; }
  python3 - "$ipa" <<'PY'
import sys, zipfile

ipa = sys.argv[1]
suffixes = (".app", ".appex", ".framework", ".bundle", ".xpc")

def is_bundle_like(name: str) -> bool:
    lower = name.lower().rstrip("/")
    return any(lower.endswith(s) for s in suffixes)

try:
    with zipfile.ZipFile(ipa) as z:
        names = z.namelist()
except zipfile.BadZipFile:
    print(
        f"IPA is not a zip archive (ITMS-90018): {ipa}",
        file=sys.stderr,
    )
    sys.exit(1)

# Payload/Name.app/... (file entries — zip often omits the directory node)
payload_apps = [
    n for n in names
    if n.startswith("Payload/")
    and any(part.endswith(".app") for part in n.split("/")[1:2])
]
if not payload_apps:
    print(f"IPA missing Payload/*.app: {ipa}", file=sys.stderr)
    sys.exit(1)

bad = []
with zipfile.ZipFile(ipa) as z:
    for info in z.infolist():
        # Unix symlink: external_attr high bits == 0o120000
        is_link = ((info.external_attr >> 16) & 0o170000) == 0o120000
        if not is_link:
            continue
        name = info.filename
        base = name.rstrip("/").split("/")[-1]
        if is_bundle_like(base) or is_bundle_like(name):
            bad.append(name)

if bad:
    print(
        "IPA contains bundle symlinks (ITMS-90018 — Apple requires a real .zip bundle, not an alias):",
        file=sys.stderr,
    )
    for n in bad[:20]:
        print(f"  {n}", file=sys.stderr)
    sys.exit(2)

print("IPA payload looks like a zip with Payload/*.app")
PY
}

# Read CFBundleIdentifier / CFBundleVersion / CFBundleShortVersionString from an IPA.
# Prints: bundle_id<TAB>version<TAB>short_version
bsl_ipa_bundle_identity() {
  local ipa="$1"
  python3 - "$ipa" <<'PY'
import plistlib, sys, zipfile

ipa = sys.argv[1]
try:
    z = zipfile.ZipFile(ipa)
except Exception:
    sys.exit(0)

plist_name = None
for name in z.namelist():
    parts = name.split("/")
    if (
        len(parts) == 3
        and parts[0] == "Payload"
        and parts[1].endswith(".app")
        and parts[2] == "Info.plist"
    ):
        plist_name = name
        break
if not plist_name:
    sys.exit(0)
try:
    info = plistlib.loads(z.read(plist_name))
except Exception:
    sys.exit(0)
bid = str(info.get("CFBundleIdentifier") or "").strip()
ver = str(info.get("CFBundleVersion") or "").strip()
short = str(info.get("CFBundleShortVersionString") or "").strip()
if bid:
    print(f"{bid}\t{ver}\t{short}")
PY
}

# Pick the App Store Connect numeric Apple ID for a bundle id from altool --list-apps JSON/XML/text.
bsl_apple_id_from_list_apps() {
  local bundle_id="$1"
  local payload
  payload="$(mktemp)"
  cat >"$payload"
  python3 - "$bundle_id" "$payload" <<'PY'
import json, re, sys, xml.etree.ElementTree as ET

want = (sys.argv[1] or "").strip().lower()
raw = open(sys.argv[2], encoding="utf-8").read()
if not want or not raw.strip():
    sys.exit(1)

def from_mapping(obj):
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            bid = str(
                cur.get("bundleID")
                or cur.get("bundleId")
                or cur.get("bundle-identifier")
                or cur.get("bundle_id")
                or ""
            ).strip().lower()
            aid = (
                cur.get("appleId")
                or cur.get("apple-id")
                or cur.get("appAdamId")
                or cur.get("adamId")
                or cur.get("Apple ID")
            )
            if bid == want and aid not in (None, ""):
                print(str(aid).strip())
                return True
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return False

text = raw.strip()
if text.startswith("{") or text.startswith("["):
    try:
        if from_mapping(json.loads(text)):
            sys.exit(0)
    except Exception:
        pass

try:
    root = ET.fromstring(text)
    def plist_to_py(elem):
        if elem.tag == "dict":
            d = {}
            key = None
            for child in list(elem):
                if child.tag == "key":
                    key = (child.text or "").strip()
                elif key is not None:
                    d[key] = plist_to_py(child)
                    key = None
            return d
        if elem.tag == "array":
            return [plist_to_py(c) for c in list(elem)]
        if elem.tag == "string":
            return elem.text or ""
        if elem.tag in ("integer", "real"):
            return elem.text or ""
        if elem.tag == "true":
            return True
        if elem.tag == "false":
            return False
        return {elem.tag: [plist_to_py(c) for c in list(elem)] or (elem.text or "")}

    parsed = plist_to_py(root)
    if from_mapping(parsed):
        sys.exit(0)
except Exception:
    pass

idx = text.lower().find(want)
window = text[max(0, idx - 400) : idx + 400] if idx >= 0 else text
m = re.search(r"(?:apple[\s-]?id|adam[\s-]?id)[\"'\s:=]+(\d{5,})", window, re.I)
if m:
    print(m.group(1))
    sys.exit(0)
sys.exit(1)
PY
  local st
  st=$?
  rm -f "$payload"
  return "$st"
}
