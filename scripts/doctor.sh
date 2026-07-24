#!/usr/bin/env bash
# doctor.sh — verify Mac is ready for buildswiftlazily deploys
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ok=0
warn=0
fail=0

pass() { echo "  ✓ $*"; ok=$((ok + 1)); }
note() { echo "  ! $*"; warn=$((warn + 1)); }
bad()  { echo "  ✗ $*"; fail=$((fail + 1)); }

echo "== buildswiftlazily doctor =="
echo

echo "[host]"
if [[ "$(uname -s)" == "Darwin" ]]; then
  pass "macOS $(sw_vers -productVersion 2>/dev/null || echo unknown)"
else
  bad "Not macOS (uname=$(uname -s)). Builds must run on the self-hosted Mac."
fi

echo
echo "[xcode]"
if command -v xcodebuild >/dev/null 2>&1; then
  pass "xcodebuild: $(xcodebuild -version 2>/dev/null | head -1)"
else
  bad "xcodebuild missing — install Xcode + CLI tools"
fi
if command -v xcrun >/dev/null 2>&1; then
  if xcrun devicectl --help >/dev/null 2>&1; then
    pass "devicectl available"
  else
    note "devicectl not available (need Xcode 15+) — direct install mode disabled"
  fi
else
  bad "xcrun missing"
fi

echo
echo "[tailscale]"
if command -v tailscale >/dev/null 2>&1; then
  pass "tailscale CLI present"
  if tailscale status >/dev/null 2>&1; then
    pass "tailscale connected"
    self="$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || true)"
    if [[ -n "${self:-}" ]]; then
      pass "MagicDNS self: $self"
    else
      note "Could not read MagicDNS name — set BSL_TS_HOST manually"
    fi
  else
    note "tailscale installed but not connected/logged in"
  fi
else
  bad "tailscale CLI missing — install from https://tailscale.com/download"
fi

echo
echo "[github]"
if command -v gh >/dev/null 2>&1; then
  pass "gh CLI present"
  if gh auth status >/dev/null 2>&1; then
    pass "gh authenticated"
  else
    note "gh not authenticated — run: gh auth login"
  fi
else
  note "gh CLI missing (optional if GITHUB_TOKEN is set in .env)"
fi

echo
echo "[config]"
if [[ -f "$ROOT/.env" ]]; then
  pass ".env present"
  # shellcheck disable=SC1091
  set -a; source "$ROOT/.env"; set +a
else
  note ".env missing — copy config/env.example → .env"
fi
if [[ -f "$ROOT/config/repos.yaml" ]]; then
  pass "config/repos.yaml present"
else
  note "config/repos.yaml missing — copy config/repos.example.yaml"
fi
if [[ -n "${BSL_TS_HOST:-}" ]]; then
  pass "BSL_TS_HOST=$BSL_TS_HOST"
else
  note "BSL_TS_HOST unset"
fi
if [[ -n "${BSL_TEAM_ID:-}" ]]; then
  pass "BSL_TEAM_ID set"
else
  note "BSL_TEAM_ID unset (needed for signing)"
fi
if [[ -n "${CURSOR_API_KEY:-}" ]]; then
  pass "CURSOR_API_KEY set"
else
  note "CURSOR_API_KEY unset — Cursor tab will be empty"
fi
if [[ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ]]; then
  pass "GITHUB_TOKEN/GH_TOKEN set"
else
  note "No GITHUB_TOKEN — relying on gh auth if available"
fi

echo
echo "[artifacts]"
ART="${BSL_ARTIFACT_ROOT:-$HOME/buildswiftlazily/artifacts}"
ART="${ART/#\~/$HOME}"
mkdir -p "$ART" 2>/dev/null || true
if [[ -d "$ART" ]]; then
  pass "artifact root: $ART"
else
  bad "cannot create artifact root: $ART"
fi

echo
echo "[devices] (optional)"
if command -v xcrun >/dev/null 2>&1 && xcrun devicectl list devices >/dev/null 2>&1; then
  count="$(xcrun devicectl list devices 2>/dev/null | grep -ci iphone || true)"
  if [[ "${count:-0}" -gt 0 ]]; then
    pass "devicectl sees ~${count} iPhone row(s)"
  else
    note "No iPhone via devicectl — OTA mode still works off-LAN"
  fi
else
  note "Skipping device list"
fi

echo
echo "== summary: $ok ok, $warn warn, $fail fail =="
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
exit 0
