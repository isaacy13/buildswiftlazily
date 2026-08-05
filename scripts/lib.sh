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
bsl_unlock_keychain_for_build() {
  local pass="${BSL_KEYCHAIN_PASSWORD:-}"
  local keychain
  keychain="$(bsl_login_keychain_path)"
  if [[ -z "$pass" ]]; then
    return 0
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi
  security unlock-keychain -p "$pass" "$keychain" >/dev/null
}
