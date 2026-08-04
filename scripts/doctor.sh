#!/usr/bin/env bash
# doctor.sh — verify Mac is ready for buildswiftlazily deploys
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

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
TS_BIN="$(bsl_find_tailscale || true)"
if [[ -n "${TS_BIN:-}" ]]; then
  pass "tailscale CLI: $TS_BIN"
  if bsl_tailscale status >/dev/null 2>&1; then
    pass "tailscale connected"
    self="$(bsl_tailscale status --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || true)"
    if [[ -n "${self:-}" ]]; then
      pass "MagicDNS self: $self"
    else
      note "Could not read MagicDNS name — set BSL_TS_HOST manually"
    fi
  else
    note "tailscale installed but not connected/logged in"
  fi
else
  # Soft warning: GUI Tailscale without CLI is common; OTA needs CLI for `tailscale serve`
  note "tailscale CLI not on PATH — install CLI from the Tailscale macOS app (or brew), needed for OTA Serve"
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
if [[ -n "${BSL_TS_HOST:-}" && "$BSL_TS_HOST" != "your-mac.tailnet-xxxx.ts.net" ]]; then
  pass "BSL_TS_HOST=$BSL_TS_HOST"
else
  note "BSL_TS_HOST unset or still placeholder"
fi
if [[ -n "${BSL_TEAM_ID:-}" && "$BSL_TEAM_ID" != "XXXXXXXXXX" ]]; then
  pass "BSL_TEAM_ID set"
else
  note "BSL_TEAM_ID unset (needed for signing)"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    guessed="$(bsl_guess_team_ids | head -3 | tr '\n' ' ')"
    if [[ -n "${guessed// /}" ]]; then
      note "Possible team IDs from keychain: $guessed"
    fi
  fi
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
if [[ -n "${BSL_GUIDEAI_REPO:-}" && "$BSL_GUIDEAI_REPO" != "YOUR_ORG_OR_USER/GuideAI" ]]; then
  pass "BSL_GUIDEAI_REPO=$BSL_GUIDEAI_REPO"
else
  if [[ -f "$ROOT/config/repos.yaml" ]] && grep -q 'YOUR_ORG_OR_USER/GuideAI' "$ROOT/config/repos.yaml" 2>/dev/null; then
    note "GuideAI slug still placeholder in config/repos.yaml"
  fi
fi

echo
echo "[signing]"
if [[ "$(uname -s)" == "Darwin" ]]; then
  if security find-identity -v -p codesigning 2>/dev/null | grep -Eq 'Apple Development|Apple Distribution|iPhone'; then
    pass "Apple codesigning identity present"
  else
    note "No Apple Development/Distribution identity — open Xcode → Settings → Accounts and sign in"
  fi
else
  note "Skipping signing probe (not Darwin)"
fi
if [[ -n "${BSL_ASC_KEY_ID:-}${ASC_KEY_ID:-}" && -n "${BSL_ASC_ISSUER_ID:-}${ASC_ISSUER_ID:-}" ]]; then
  KEY_ID="${BSL_ASC_KEY_ID:-${ASC_KEY_ID:-}}"
  KEY_DIR="${BSL_ASC_KEY_PATH:-${API_PRIVATE_KEYS_DIR:-$HOME/.appstoreconnect/private_keys}}"
  KEY_DIR="${KEY_DIR/#\~/$HOME}"
  if [[ -f "$KEY_DIR" ]]; then
    pass "ASC API key file configured"
  elif [[ -f "$KEY_DIR/AuthKey_${KEY_ID}.p8" ]]; then
    pass "ASC AuthKey_${KEY_ID}.p8 present"
  else
    note "ASC key IDs set but AuthKey_${KEY_ID}.p8 not found under $KEY_DIR"
  fi
else
  note "TestFlight ASC API key not configured (optional)"
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
echo "[workflow]"
if [[ -f "$ROOT/.github/workflows/deploy-ios.yml" ]]; then
  pass "deploy-ios.yml present in this checkout"
  TOOLING_REF="${BSL_TOOLING_REF:-main}"
  if [[ "$TOOLING_REF" == "main" ]]; then
    note "BSL_TOOLING_REF=main — Actions engine needs deploy-ios.yml on default branch (or set BSL_TOOLING_REF to this branch). Local engine is fine."
  else
    pass "BSL_TOOLING_REF=$TOOLING_REF"
  fi
else
  note "deploy-ios.yml missing from checkout"
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
echo "[first-run tip]"
echo "  ./scripts/bootstrap.sh   # once"
echo "  ./scripts/start.sh       # control plane + Tailscale Serve"

echo
echo "== summary: $ok ok, $warn warn, $fail fail =="
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
exit 0
