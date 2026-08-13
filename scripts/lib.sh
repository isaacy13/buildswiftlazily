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
