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

# Move "Embed Foundation Extensions" / "Embed App Extensions" to after
# Sources/Frameworks/Resources and before Thin Binary / CocoaPods / Run Scripts.
# Xcode 15+ often appends the embed phase *after* Thin Binary, which fails archive.
# Putting it *first* (before Sources) is also wrong — the .app does not exist yet.
# Safe no-op when no matching phase exists or the order is already correct.
bsl_fix_embed_extension_phases() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  python3 - "$root" <<'PY'
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
embed_re = re.compile(
    r"Embed (?:Foundation|App|ExtensionKit) Extensions|"
    r"Embed Watch Content|Embed App Clips",
    re.I,
)
# Phases that must run before the .app exists to copy PlugIns into.
early_re = re.compile(
    r"^(?:Sources|Headers|Frameworks|Resources|Dependencies|"
    r"Compile Sources|Link Binary With Libraries|Copy Bundle Resources|"
    r"\[CP\] Check Pods Manifest\.lock)$",
    re.I,
)
phase_line_re = re.compile(
    r"^(\s*)([A-Fa-f0-9]{24})\s*/\*\s*(.*?)\s*\*/\s*,\s*$"
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
            body = []
            for bi, bl in enumerate(block):
                m = phase_line_re.match(bl.rstrip("\n"))
                if m:
                    body.append((bi, m.group(1), m.group(2), m.group(3)))
            embeds = [t for t in body if embed_re.search(t[3])]
            if embeds:
                embed_ids = {t[2] for t in embeds}
                early = [
                    t
                    for t in body
                    if t[2] not in embed_ids and early_re.match(t[3].strip())
                ]
                late = [
                    t
                    for t in body
                    if t[2] not in embed_ids and t not in early
                ]
                # Keep relative order inside each bucket.
                new_order = early + embeds + late
                if [t[2] for t in new_order] != [t[2] for t in body]:
                    id_bis = {t[0] for t in body}
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

# CocoaPods / Flutter / extension-embed Run Scripts fail archive when Xcode 15+
# sandboxes them (can't codesign or rsync into the .app). Flip the project
# setting so the override is not only a command-line build setting.
bsl_disable_user_script_sandboxing() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  python3 - "$root" <<'PY'
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
pat = re.compile(r"ENABLE_USER_SCRIPT_SANDBOXING\s*=\s*YES")
changed = 0
for pbx in root.rglob("project.pbxproj"):
    parts_l = {x.lower() for x in pbx.parts}
    if "pods" in parts_l or ".build" in parts_l or "sourcedpackages" in parts_l:
        continue
    original = pbx.read_text(encoding="utf-8", errors="replace")
    new, n = pat.subn("ENABLE_USER_SCRIPT_SANDBOXING = NO", original)
    if n:
        pbx.write_text(new, encoding="utf-8")
        changed += 1
        print(f"Disabled ENABLE_USER_SCRIPT_SANDBOXING in {pbx} ({n} setting(s))")
if changed == 0:
    print("No ENABLE_USER_SCRIPT_SANDBOXING=YES settings to clear")
PY
}

# Apple ITMS-90018 ("The file extension must be .zip") is the processing email
# you get when a "bundle" inside the IPA (.app / .appex / .framework / .bundle)
# is a symlink (often to DerivedData) instead of a real copy. Materialize those
# in the xcarchive before exportArchive re-signs.
#
# Extra args are optional search roots (xcarchive, DerivedData). Xcode often
# writes PlugIns/*.appex as a relative alias to UninstalledProducts; that path
# is relative to Products/Applications, so it dangles once copied into PlugIns.
bsl_materialize_bundle_symlinks() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  shift
  python3 - "$root" "$@" <<'PY'
from __future__ import annotations

import os, pathlib, shutil, sys

root = pathlib.Path(sys.argv[1]).resolve()
extra_roots = [pathlib.Path(p).resolve() for p in sys.argv[2:] if p]
suffixes = (".app", ".appex", ".framework", ".bundle", ".xpc")
SKIP_WALK = {
    "Index.noindex",
    "ModuleCache.noindex",
    "SymbolCache",
    "Logs",
    "SDKStatCaches.noindex",
    "CompilationCache.noindex",
}

def is_bundle_like(path: pathlib.Path) -> bool:
    name = path.name.lower()
    return any(name.endswith(s) for s in suffixes)

def real_bundle(path: pathlib.Path, skip_link: pathlib.Path) -> pathlib.Path | None:
    """Return a real file/dir to copy. Never return the symlink we are replacing."""
    try:
        if path == skip_link:
            return None
        if path.is_symlink():
            if not path.exists():
                return None
            path = path.resolve()
            if path == skip_link:
                return None
        if not path.exists():
            return None
        if path.is_dir() or path.is_file():
            return path
    except OSError:
        return None
    return None

def marker_suffixes(raw: str) -> list[pathlib.Path]:
    parts = pathlib.PurePosixPath(raw.replace("\\", "/")).parts
    out = []
    for marker in ("UninstalledProducts", "IntermediateBuildFilesPath", "BuildProductsPath"):
        if marker in parts:
            i = parts.index(marker)
            out.append(pathlib.Path(*parts[i:]))
    return out

def consider_under(base: pathlib.Path, name: str, skip_link: pathlib.Path) -> pathlib.Path | None:
    if not base.exists() or not base.is_dir():
        return None
    hit = real_bundle(base / name, skip_link)
    if hit:
        return hit
    try:
        for child in base.iterdir():
            if child.is_dir() and not child.is_symlink():
                hit = real_bundle(child / name, skip_link)
                if hit:
                    return hit
    except OSError:
        return None
    return None

def find_real_bundle(link: pathlib.Path, raw: str) -> pathlib.Path | None:
    skip_link = link
    if os.path.isabs(raw):
        hit = real_bundle(pathlib.Path(raw), skip_link)
        if hit:
            return hit
    else:
        rel = pathlib.Path(raw)
        for ancestor in [link.parent, *link.parents]:
            hit = real_bundle(pathlib.Path(os.path.normpath(ancestor / rel)), skip_link)
            if hit:
                return hit

    suffixes_from_raw = marker_suffixes(raw)
    search_roots: list[pathlib.Path] = []
    seen: set[pathlib.Path] = set()

    def add_root(p: pathlib.Path) -> None:
        try:
            r = p.resolve()
        except OSError:
            r = p
        if r in seen or not r.exists():
            return
        seen.add(r)
        search_roots.append(r)

    add_root(root)
    for extra in extra_roots:
        add_root(extra)
    for ancestor in link.parents:
        add_root(ancestor)
        if (ancestor / "Products" / "Applications").is_dir():
            break

    for base in list(search_roots):
        aa = base / "Build" / "Intermediates.noindex" / "ArchiveIntermediates"
        add_root(aa)
        if aa.is_dir():
            try:
                for scheme_dir in aa.iterdir():
                    add_root(scheme_dir)
            except OSError:
                pass

    name = link.name
    for base in search_roots:
        for suffix in suffixes_from_raw:
            hit = real_bundle(base / suffix, skip_link)
            if hit:
                return hit
        for rel in (
            pathlib.Path("IntermediateBuildFilesPath") / "UninstalledProducts",
            pathlib.Path("UninstalledProducts"),
            pathlib.Path("BuildProductsPath"),
        ):
            hit = consider_under(base / rel, name, skip_link)
            if hit:
                return hit
        products = base / "Build" / "Products"
        hit = consider_under(products, name, skip_link)
        if hit:
            return hit

    # Last resort: shallow walk of archive intermediates only (not all DerivedData).
    walk_roots = [
        p
        for p in search_roots
        if p.name in {"ArchiveIntermediates", "UninstalledProducts", "IntermediateBuildFilesPath"}
        or (p / "IntermediateBuildFilesPath").is_dir()
        or (p / "UninstalledProducts").is_dir()
    ]
    for walk_root in walk_roots:
        for dirpath, dirnames, _filenames in os.walk(walk_root, followlinks=False):
            dirnames[:] = [d for d in dirnames if d not in SKIP_WALK]
            base = pathlib.Path(dirpath)
            if base.name == name:
                hit = real_bundle(base, skip_link)
                if hit:
                    return hit
            if name in dirnames:
                hit = real_bundle(base / name, skip_link)
                if hit:
                    return hit
    return None

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
    target = find_real_bundle(link, raw)
    if target is None:
        print(
            f"error: Dangling bundle symlink (ITMS-90018): {link} -> {raw}",
            file=sys.stderr,
        )
        print(
            "error: Could not find a real .appex/.framework copy under the "
            "archive IntermediateBuildFilesPath or DerivedData UninstalledProducts.",
            file=sys.stderr,
        )
        sys.exit(2)
    tmp = link.with_name(link.name + ".bsl-real")
    if tmp.exists():
        shutil.rmtree(tmp) if tmp.is_dir() and not tmp.is_symlink() else tmp.unlink()
    if target.is_dir():
        shutil.copytree(target, tmp, symlinks=False, ignore_dangling_symlinks=True)
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

# Pick the App Store Connect numeric Apple ID for a bundle id from altool --list-apps
# JSON/XML/text, or from GET /v1/apps App Store Connect API JSON.
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

def get_ci(d, *names):
    if not isinstance(d, dict):
        return None
    lower = {str(k).lower(): v for k, v in d.items()}
    for n in names:
        v = lower.get(n.lower())
        if v not in (None, ""):
            return v
    return None

def from_mapping(obj):
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            attrs = cur.get("attributes") if isinstance(cur.get("attributes"), dict) else {}
            bid = str(
                get_ci(cur, "bundleID", "bundleId", "bundle-identifier", "bundle_id", "bundleIdentifier")
                or get_ci(attrs, "bundleID", "bundleId", "bundle-identifier", "bundle_id", "bundleIdentifier")
                or ""
            ).strip().lower()
            aid = get_ci(
                cur,
                "appleId",
                "appleID",
                "apple-id",
                "appAdamId",
                "adamId",
                "Apple ID",
                "applicationId",
            )
            typ = str(cur.get("type") or "").strip().lower()
            if aid in (None, "") and typ in ("apps", "app"):
                aid = cur.get("id")
            if bid == want and aid not in (None, ""):
                print(str(aid).strip())
                return True
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return False

def try_json(blob):
    blob = blob.strip()
    candidates = []
    if blob.startswith("{") or blob.startswith("["):
        candidates.append(blob)
    start, end = blob.find("{"), blob.rfind("}")
    if start >= 0 and end > start:
        candidates.append(blob[start : end + 1])
    seen = set()
    for c in candidates:
        if c in seen:
            continue
        seen.add(c)
        try:
            if from_mapping(json.loads(c)):
                return True
        except Exception:
            pass
    return False

text = raw.strip()
if try_json(text):
    sys.exit(0)

try:
    xml_text = text
    if not xml_text.lstrip().startswith("<"):
        lt = xml_text.find("<")
        if lt >= 0:
            xml_text = xml_text[lt:]
    root = ET.fromstring(xml_text)
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
window = text[max(0, idx - 800) : idx + 800] if idx >= 0 else text
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

# ES256 JWT for App Store Connect API (AuthKey_*.p8). Prints token to stdout.
bsl_asc_jwt() {
  local key_id="$1" issuer_id="$2" p8="$3"
  [[ -n "$key_id" && -n "$issuer_id" && -f "$p8" ]] || return 1
  python3 - "$key_id" "$issuer_id" "$p8" <<'PY'
import base64, json, subprocess, sys, time

kid, iss, p8 = sys.argv[1], sys.argv[2], sys.argv[3]

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def der_ecdsa_to_rs(der: bytes) -> bytes:
    if not der or der[0] != 0x30:
        raise ValueError("not a DER ECDSA signature")
    i = 1
    seq_len = der[i]
    i += 1
    if seq_len & 0x80:
        i += seq_len & 0x7F

    def read_int() -> bytes:
        nonlocal i
        if i >= len(der) or der[i] != 0x02:
            raise ValueError("expected INTEGER")
        i += 1
        ln = der[i]
        i += 1
        if ln & 0x80:
            n = ln & 0x7F
            ln = int.from_bytes(der[i : i + n], "big")
            i += n
        val = der[i : i + ln]
        i += ln
        while len(val) > 32 and val[0] == 0:
            val = val[1:]
        if len(val) > 32:
            raise ValueError("integer too large for P-256")
        return val.rjust(32, b"\x00")

    return read_int() + read_int()

header = b64url(json.dumps({"alg": "ES256", "kid": kid, "typ": "JWT"}, separators=(",", ":")).encode())
now = int(time.time())
payload = b64url(json.dumps({
    "iss": iss,
    "iat": now,
    "exp": now + 12 * 60,
    "aud": "appstoreconnect-apple.com",
}, separators=(",", ":")).encode())
signing_input = f"{header}.{payload}".encode()
der = subprocess.check_output(["openssl", "dgst", "-sha256", "-sign", p8], input=signing_input)
print(f"{header}.{payload}.{b64url(der_ecdsa_to_rs(der))}")
PY
}

# Look up numeric Apple ID via GET /v1/apps?filter[bundleId]=…
bsl_asc_api_apple_id() {
  local bundle_id="$1" key_id="$2" issuer_id="$3" p8="$4"
  local token json
  [[ -n "$bundle_id" && -n "$key_id" && -n "$issuer_id" && -f "$p8" ]] || return 1
  token="$(bsl_asc_jwt "$key_id" "$issuer_id" "$p8")" || return 1
  json="$(python3 - "$bundle_id" "$token" <<'PY'
import sys, urllib.error, urllib.parse, urllib.request

bundle, token = sys.argv[1], sys.argv[2]
q = urllib.parse.urlencode({"filter[bundleId]": bundle, "limit": "10"})
req = urllib.request.Request(
    "https://api.appstoreconnect.apple.com/v1/apps?" + q,
    headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        sys.stdout.write(resp.read().decode("utf-8", "replace"))
except Exception as e:
    sys.stderr.write(f"ASC apps lookup failed: {e}\n")
    sys.exit(1)
PY
)" || return 1
  printf '%s\n' "$json" | bsl_apple_id_from_list_apps "$bundle_id"
}

# Locate AuthKey_<KEY_ID>.p8. Optional second arg is a file or directory override.
bsl_asc_find_p8() {
  local key_id="$1"
  local candidate="${2:-${BSL_ASC_KEY_PATH:-${API_PRIVATE_KEYS_DIR:-}}}"
  [[ -n "$key_id" ]] || return 1
  if [[ -n "$candidate" ]]; then
    candidate="${candidate/#\~/$HOME}"
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    if [[ -d "$candidate" && -f "$candidate/AuthKey_${key_id}.p8" ]]; then
      printf '%s\n' "$candidate/AuthKey_${key_id}.p8"
      return 0
    fi
  fi
  local d
  for d in \
    "$HOME/.appstoreconnect/private_keys" \
    "$HOME/private_keys" \
    "$HOME/.private_keys" \
    "./private_keys"; do
    if [[ -f "$d/AuthKey_${key_id}.p8" ]]; then
      printf '%s\n' "$d/AuthKey_${key_id}.p8"
      return 0
    fi
  done
  return 1
}

# Read PRODUCT_BUNDLE_IDENTIFIER / CURRENT_PROJECT_VERSION / MARKETING_VERSION
# from an Xcode checkout (pbxproj, xcconfig, Info.plist). Prints:
#   bundle_id<TAB>version<TAB>short_version
# Prefers Release (or the given configuration) on an application target matching scheme.
bsl_source_bundle_identity() {
  local root="$1" scheme="${2:-}" configuration="${3:-Release}"
  [[ -d "$root" ]] || return 1
  python3 - "$root" "$scheme" "$configuration" <<'PY'
import os, plistlib, re, sys

root, scheme, configuration = sys.argv[1], sys.argv[2], sys.argv[3]
SKIP_DIRS = {
    "Pods", "Carthage", "DerivedData", ".git", "build", ".build",
    "node_modules", "vendor", ".swiftpm", "xcuserdata",
}
SKIP_NAME_BITS = ("tests", "uitests")
EXT_HINTS = (
    "tests", "uitests", "widget", "extension", "watch", "intent", "clip", "appex",
)

def skip_dir(name: str) -> bool:
    if name in SKIP_DIRS or name.endswith(".xcframework") or name.endswith(".framework"):
        return True
    low = name.lower()
    return low.endswith("tests") or low.endswith("uitests")

def strip_val(raw: str) -> str:
    v = raw.strip().strip(";")
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v.strip()

def subst(val: str, mapping: dict, depth: int = 0) -> str:
    if not val or depth > 8:
        return val
    def repl(m):
        key = m.group(1).split(":")[0]
        got = mapping.get(key)
        return got if got not in (None, "") else m.group(0)
    nxt = re.sub(r"\$\(([^)]+)\)", repl, val)
    return subst(nxt, mapping, depth + 1) if nxt != val else nxt

def extract_brace(text: str, open_idx: int) -> str:
    depth = 0
    i = open_idx
    n = len(text)
    while i < n:
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[open_idx : i + 1]
        elif c == '"':
            i += 1
            while i < n and text[i] != '"':
                if text[i] == "\\":
                    i += 1
                i += 1
        i += 1
    return text[open_idx:]

SETTING_KEYS = (
    "CURRENT_PROJECT_VERSION",
    "MARKETING_VERSION",
    "PRODUCT_BUNDLE_IDENTIFIER",
    "PRODUCT_NAME",
    "INFOPLIST_KEY_CFBundleDisplayName",
)

def parse_settings_blob(blob: str) -> dict:
    out = {}
    for key in SETTING_KEYS:
        m = re.search(rf"{key}\s*=\s*([^;\n]+)", blob)
        if m:
            out[key] = strip_val(m.group(1))
    return out

def parse_xcconfig(path: str) -> dict:
    out = {}
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return out
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("//") or s.startswith("#"):
            continue
        m = re.match(r"([A-Z0-9_]+)\s*=\s*(.*)$", s)
        if m and m.group(1) in SETTING_KEYS:
            out[m.group(1)] = strip_val(m.group(2))
    return out

def parse_info_plist(path: str) -> dict:
    try:
        with open(path, "rb") as f:
            info = plistlib.load(f)
    except Exception:
        return {}
    if not isinstance(info, dict):
        return {}
    out = {}
    bid = str(info.get("CFBundleIdentifier") or "").strip()
    ver = str(info.get("CFBundleVersion") or "").strip()
    short = str(info.get("CFBundleShortVersionString") or "").strip()
    name = str(info.get("CFBundleName") or info.get("CFBundleDisplayName") or "").strip()
    if bid:
        out["PRODUCT_BUNDLE_IDENTIFIER"] = bid
    if ver:
        out["CURRENT_PROJECT_VERSION"] = ver
    if short:
        out["MARKETING_VERSION"] = short
    if name:
        out["PRODUCT_NAME"] = name
    return out

def parse_pbxproj(path: str) -> list:
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return []
    objects = {}
    for m in re.finditer(
        r"([0-9A-Fa-f]{20,32})(?:\s*/\*[^*]*\*/)?\s*=\s*\{",
        text,
    ):
        block = extract_brace(text, m.end() - 1)
        objects[m.group(1)] = block

    lists = {}
    for oid, block in objects.items():
        if "isa = XCConfigurationList" not in block:
            continue
        ids = re.findall(r"([0-9A-Fa-f]{20,32})", block.split("buildConfigurations", 1)[-1] if "buildConfigurations" in block else "")
        lists[oid] = ids

    targets = []
    for oid, block in objects.items():
        if "isa = PBXNativeTarget" not in block:
            continue
        name_m = re.search(r"\bname\s*=\s*([^;]+);", block)
        ptype_m = re.search(r"productType\s*=\s*([^;]+);", block)
        clist_m = re.search(r"buildConfigurationList\s*=\s*([0-9A-Fa-f]{20,32})", block)
        name = strip_val(name_m.group(1)) if name_m else ""
        ptype = strip_val(ptype_m.group(1)) if ptype_m else ""
        clist = clist_m.group(1) if clist_m else ""
        targets.append((name, ptype, clist))

    cfgs = []
    for oid, block in objects.items():
        if "isa = XCBuildConfiguration" not in block:
            continue
        name_m = re.search(r"\bname\s*=\s*([^;]+);", block)
        settings_m = re.search(r"buildSettings\s*=\s*\{", block)
        settings = {}
        if settings_m:
            settings = parse_settings_blob(extract_brace(block, settings_m.end() - 1))
        else:
            settings = parse_settings_blob(block)
        cfg_name = strip_val(name_m.group(1)) if name_m else ""
        cfgs.append((oid, cfg_name, settings))

    # Attach target name/type onto each configuration when we can.
    cfg_by_id = {oid: (name, settings) for oid, name, settings in cfgs}
    out = []
    used = set()
    for tname, ptype, clist in targets:
        for cid in lists.get(clist, []):
            if cid not in cfg_by_id:
                continue
            cfg_name, settings = cfg_by_id[cid]
            row = dict(settings)
            row["_config"] = cfg_name
            row["_target"] = tname
            row["_product"] = ptype
            out.append(row)
            used.add(cid)
    for oid, cfg_name, settings in cfgs:
        if oid in used:
            continue
        row = dict(settings)
        row["_config"] = cfg_name
        row["_target"] = ""
        row["_product"] = ""
        out.append(row)
    return out

candidates = []
info_rows = []
xc_map = {}
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if not skip_dir(d)]
    for fn in filenames:
        path = os.path.join(dirpath, fn)
        if fn == "project.pbxproj":
            candidates.extend(parse_pbxproj(path))
        elif fn.endswith(".xcconfig"):
            xc_map.update(parse_xcconfig(path))
        elif fn == "Info.plist":
            rel = path[len(root) :].replace("\\", "/").lower()
            if any(b in rel for b in ("/pods/", "/tests/", "/uitests/", ".appex/", ".xctest/")):
                continue
            row = parse_info_plist(path)
            if row:
                row["_config"] = ""
                row["_target"] = ""
                row["_product"] = ""
                info_rows.append(row)

# xcconfig values fill holes on every candidate.
if xc_map:
    if not candidates:
        row = dict(xc_map)
        row["_config"] = configuration or "Release"
        row["_target"] = scheme
        row["_product"] = "com.apple.product-type.application"
        candidates.append(row)
    else:
        for row in candidates:
            for k, v in xc_map.items():
                if not row.get(k):
                    row[k] = v

candidates.extend(info_rows)

def looks_extension(row: dict) -> bool:
    ptype = (row.get("_product") or "").lower()
    if "application" in ptype and "watch" not in ptype:
        return False
    if "appex" in ptype or "extension" in ptype or "watch" in ptype:
        return True
    blob = " ".join(
        str(row.get(k) or "") for k in ("_target", "PRODUCT_NAME", "PRODUCT_BUNDLE_IDENTIFIER")
    ).lower()
    return any(h in blob for h in EXT_HINTS)

def score(row: dict) -> int:
    s = 0
    cfg = (row.get("_config") or "").strip()
    if configuration and cfg.lower() == configuration.lower():
        s += 30
    elif cfg.lower() == "release":
        s += 20
    elif cfg.lower() == "debug":
        s -= 5
    ptype = (row.get("_product") or "").lower()
    if "application" in ptype:
        s += 15
    if looks_extension(row):
        s -= 40
    tname = (row.get("_target") or row.get("PRODUCT_NAME") or "").strip()
    if scheme and tname and scheme.lower() == tname.lower():
        s += 25
    elif scheme and tname and scheme.lower() in tname.lower():
        s += 8
    if row.get("CURRENT_PROJECT_VERSION"):
        s += 2
    if row.get("PRODUCT_BUNDLE_IDENTIFIER"):
        s += 2
    return s

if not candidates:
    sys.exit(1)

best = sorted(candidates, key=score, reverse=True)[0]
mapping = {}
for row in sorted(candidates, key=score):
    for k in SETTING_KEYS:
        if row.get(k):
            mapping[k] = row[k]
for k in SETTING_KEYS:
    if best.get(k):
        mapping[k] = best[k]
if scheme:
    mapping.setdefault("PRODUCT_NAME", scheme)
    mapping.setdefault("TARGET_NAME", scheme)

bid = subst(str(best.get("PRODUCT_BUNDLE_IDENTIFIER") or mapping.get("PRODUCT_BUNDLE_IDENTIFIER") or ""), mapping)
ver = subst(str(best.get("CURRENT_PROJECT_VERSION") or mapping.get("CURRENT_PROJECT_VERSION") or ""), mapping)
short = subst(str(best.get("MARKETING_VERSION") or mapping.get("MARKETING_VERSION") or ""), mapping)
if "$(" in bid:
    bid = ""
if "$(" in ver:
    ver = ""
if "$(" in short:
    short = ""
bid, ver, short = bid.strip(), ver.strip(), short.strip()
if not bid and not ver:
    sys.exit(1)
print(f"{bid}\t{ver}\t{short}")
PY
}

# Parse App Store Connect GET /v1/builds JSON (or {exact, latest} wrapper).
# Prints EXISTS=0|1 plus MATCH_* / LATEST_* fields. Arg 1 is CFBundleVersion.
# JSON is read from stdin (copied to a temp file so the Python heredoc can use stdin).
bsl_asc_parse_builds_status() {
  local want="$1"
  local payload
  payload="$(mktemp)"
  cat >"$payload"
  python3 - "$want" "$payload" <<'PY'
import json, re, sys

want = (sys.argv[1] or "").strip()
raw = open(sys.argv[2], encoding="utf-8").read()
try:
    payload = json.loads(raw)
except Exception:
    sys.exit(1)

def as_list(obj):
    if obj is None:
        return []
    if isinstance(obj, list):
        return obj
    return [obj]

def walk(obj, acc_builds, acc_inc):
    if isinstance(obj, dict):
        typ = str(obj.get("type") or "")
        if typ == "builds":
            acc_builds.append(obj)
        elif typ == "preReleaseVersions" and obj.get("id"):
            acc_inc[str(obj["id"])] = obj
        data = obj.get("data")
        if isinstance(data, list):
            for item in data:
                walk(item, acc_builds, acc_inc)
        elif isinstance(data, dict):
            walk(data, acc_builds, acc_inc)
        for inc in as_list(obj.get("included")):
            walk(inc, acc_builds, acc_inc)
        for k in ("exact", "latest"):
            if k in obj:
                walk(obj[k], acc_builds, acc_inc)
    elif isinstance(obj, list):
        for item in obj:
            walk(item, acc_builds, acc_inc)

builds, included = [], {}
walk(payload, builds, included)

def attrs(b):
    a = b.get("attributes") if isinstance(b.get("attributes"), dict) else {}
    return a

def version_of(b):
    return str(attrs(b).get("version") or "").strip()

def state_of(b):
    return str(attrs(b).get("processingState") or "").strip()

def uploaded_of(b):
    return str(attrs(b).get("uploadedDate") or "")

def short_of(b):
    rel = b.get("relationships") if isinstance(b.get("relationships"), dict) else {}
    prv = rel.get("preReleaseVersion") if isinstance(rel.get("preReleaseVersion"), dict) else {}
    data = prv.get("data") if isinstance(prv.get("data"), dict) else {}
    pid = str(data.get("id") or "")
    inc = included.get(pid) or {}
    ia = inc.get("attributes") if isinstance(inc.get("attributes"), dict) else {}
    return str(ia.get("version") or "").strip()

# Dedupe by id, keep first.
seen = set()
uniq = []
for b in builds:
    bid = str(b.get("id") or "")
    key = bid or (version_of(b), uploaded_of(b), id(b))
    if key in seen:
        continue
    seen.add(key)
    uniq.append(b)

matches = [b for b in uniq if want and version_of(b) == want]
latest = None
dated = [b for b in uniq if uploaded_of(b)]
if dated:
    latest = sorted(dated, key=uploaded_of, reverse=True)[0]
elif uniq:
    latest = uniq[0]
match = matches[0] if matches else None

def ver_tuple(s):
    if not s or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", s):
        return None
    return tuple(int(p) for p in s.split("."))

older = 0
lt = ver_tuple(want)
rt = ver_tuple(version_of(latest) if latest else "")
if lt is not None and rt is not None:
    n = max(len(lt), len(rt))
    lt = lt + (0,) * (n - len(lt))
    rt = rt + (0,) * (n - len(rt))
    if lt < rt:
        older = 1

print(f"EXISTS={1 if match else 0}")
if match:
    print(f"MATCH_VERSION={version_of(match)}")
    print(f"MATCH_STATE={state_of(match)}")
    ms = short_of(match)
    if ms:
        print(f"MATCH_SHORT={ms}")
if latest:
    print(f"LATEST_VERSION={version_of(latest)}")
    print(f"LATEST_STATE={state_of(latest)}")
    ls = short_of(latest)
    if ls:
        print(f"LATEST_SHORT={ls}")
print(f"OLDER={older}")
PY
  local st
  st=$?
  rm -f "$payload"
  return "$st"
}

# Query App Store Connect for existing builds of bundle_id + CFBundleVersion.
# Prints the same keys as bsl_asc_parse_builds_status. Uses an already-minted JWT.
bsl_asc_api_build_status() {
  local bundle_id="$1" version="$2" token="$3"
  [[ -n "$bundle_id" && -n "$version" && -n "$token" ]] || return 1
  python3 - "$bundle_id" "$version" "$token" <<'PY'
import json, sys, urllib.error, urllib.parse, urllib.request

bundle, version, token = sys.argv[1], sys.argv[2], sys.argv[3]

def get(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:
        sys.stderr.write(f"ASC builds lookup failed: {e}\n")
        sys.exit(1)

q_app = urllib.parse.urlencode({"filter[bundleId]": bundle, "limit": "10"})
apps = get("https://api.appstoreconnect.apple.com/v1/apps?" + q_app)
app_id = ""
for item in apps.get("data") or []:
    if not isinstance(item, dict):
        continue
    attrs = item.get("attributes") if isinstance(item.get("attributes"), dict) else {}
    bid = str(attrs.get("bundleId") or "").strip()
    if bid.lower() == bundle.lower():
        app_id = str(item.get("id") or "").strip()
        break
if not app_id:
    sys.stderr.write(f"No App Store Connect app record for {bundle}\n")
    sys.exit(2)

fields = "version,processingState,uploadedDate,expired"
inc = "preReleaseVersion"
q_exact = urllib.parse.urlencode(
    {
        "filter[app]": app_id,
        "filter[version]": version,
        "include": inc,
        "fields[builds]": fields,
        "fields[preReleaseVersions]": "version",
        "limit": "10",
    }
)
q_latest = urllib.parse.urlencode(
    {
        "filter[app]": app_id,
        "sort": "-uploadedDate",
        "include": inc,
        "fields[builds]": fields,
        "fields[preReleaseVersions]": "version",
        "limit": "5",
    }
)
exact = get("https://api.appstoreconnect.apple.com/v1/builds?" + q_exact)
latest = get("https://api.appstoreconnect.apple.com/v1/builds?" + q_latest)
json.dump({"exact": exact, "latest": latest, "appId": app_id}, sys.stdout)
PY
}

# Fail (exit 2) when CFBundleVersion already exists on App Store Connect.
# Skip (exit 0) when dry-run, unconfigured, or the API is unreachable.
# Usage: bsl_asc_assert_unique_cfbundle_version <bundle_id> <version> [short]
bsl_asc_assert_unique_cfbundle_version() {
  local bundle_id="$1" version="$2" short="${3:-}"
  if [[ "${BSL_SKIP_ASC_VERSION_CHECK:-0}" == "1" ]]; then
    echo "TESTFLIGHT_VERSION_CHECK=skip (BSL_SKIP_ASC_VERSION_CHECK=1)"
    return 0
  fi
  if [[ -z "$bundle_id" || -z "$version" ]]; then
    echo "TESTFLIGHT_VERSION_CHECK=skip (need bundle id + CFBundleVersion)"
    return 0
  fi
  if [[ "${BSL_DRY_RUN:-0}" == "1" ]]; then
    echo "DRY_RUN: would query App Store Connect for ${bundle_id} CFBundleVersion=${version}${short:+ short=${short}}"
    echo "TESTFLIGHT_VERSION_CHECK=dry-run"
    return 0
  fi

  local key_id issuer_id p8 token json status
  key_id="${BSL_ASC_KEY_ID:-${ASC_KEY_ID:-}}"
  issuer_id="${BSL_ASC_ISSUER_ID:-${ASC_ISSUER_ID:-}}"
  if [[ -z "$key_id" || -z "$issuer_id" ]]; then
    echo "TESTFLIGHT_VERSION_CHECK=skip (no ASC API key — upload will need BSL_ASC_KEY_ID / ISSUER_ID)"
    return 0
  fi
  p8="$(bsl_asc_find_p8 "$key_id" || true)"
  if [[ -z "$p8" || ! -f "$p8" ]]; then
    echo "TESTFLIGHT_VERSION_CHECK=skip (AuthKey_${key_id}.p8 not found)"
    return 0
  fi
  token="$(bsl_asc_jwt "$key_id" "$issuer_id" "$p8" || true)"
  if [[ -z "$token" ]]; then
    echo "TESTFLIGHT_VERSION_CHECK=skip (could not mint ASC JWT)"
    return 0
  fi

  echo "Checking App Store Connect for ${bundle_id} CFBundleVersion=${version} (before a long archive/upload)…"
  local errf
  errf="$(mktemp)"
  json="$(bsl_asc_api_build_status "$bundle_id" "$version" "$token" 2>"$errf" || true)"
  if [[ -z "$json" ]]; then
    if [[ -s "$errf" ]]; then
      echo "TESTFLIGHT_VERSION_CHECK=skip (ASC API: $(tr '\n' ' ' <"$errf" | head -c 200))"
    else
      echo "TESTFLIGHT_VERSION_CHECK=skip (ASC API unreachable)"
    fi
    rm -f "$errf"
    return 0
  fi
  rm -f "$errf"
  status="$(printf '%s\n' "$json" | bsl_asc_parse_builds_status "$version" || true)"
  if [[ -z "$status" ]]; then
    echo "TESTFLIGHT_VERSION_CHECK=skip (could not parse ASC builds response)"
    return 0
  fi
  local exists=0 latest="" latest_short="" latest_state="" match_state="" older=0
  while IFS= read -r line; do
    case "$line" in
      EXISTS=1) exists=1 ;;
      MATCH_STATE=*) match_state="${line#MATCH_STATE=}" ;;
      LATEST_VERSION=*) latest="${line#LATEST_VERSION=}" ;;
      LATEST_SHORT=*) latest_short="${line#LATEST_SHORT=}" ;;
      LATEST_STATE=*) latest_state="${line#LATEST_STATE=}" ;;
      OLDER=1) older=1 ;;
    esac
  done <<<"$status"

  if [[ "$exists" == "1" ]]; then
    echo "error: CFBundleVersion ${version} already exists on App Store Connect${match_state:+ (state=${match_state})}." >&2
    if [[ -n "$latest" ]]; then
      echo "Latest ASC build: ${latest}${latest_short:+ (${latest_short})}${latest_state:+, ${latest_state}}" >&2
    fi
    echo "Bump CURRENT_PROJECT_VERSION / CFBundleVersion in Xcode, commit, and retry. Archive was not started." >&2
    echo "TESTFLIGHT_VERSION_CHECK=duplicate" >&2
    return 2
  fi

  if [[ -n "$latest" ]]; then
    echo "Latest ASC build: ${latest}${latest_short:+ (${latest_short})}${latest_state:+, ${latest_state}}"
  else
    echo "No existing TestFlight builds found for ${bundle_id}."
  fi
  if [[ "$older" == "1" && -n "$latest" ]]; then
    echo "Note: CFBundleVersion ${version} is lower than latest ASC ${latest} — Apple may still reject the upload."
  fi
  echo "CFBundleVersion ${version} is new on App Store Connect."
  echo "TESTFLIGHT_VERSION_CHECK=ok"
  return 0
}
