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
