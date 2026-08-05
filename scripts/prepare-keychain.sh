#!/usr/bin/env bash
# prepare-keychain.sh — one-time (or occasional) Mac setup so codesign does not
# pop interactive Keychain dialogs during couch builds.
#
# Why: macOS has no way to tap “Allow” on Keychain ACL prompts from an iPhone.
# The fix is to grant codesign partition access once, then unlock before builds.
#
# Usage (on the Mac, logged into a GUI session at least once):
#   ./scripts/prepare-keychain.sh
#   BSL_KEYCHAIN_PASSWORD='…' ./scripts/prepare-keychain.sh   # non-interactive
#
# After this succeeds, optional: put the same password in .env as
# BSL_KEYCHAIN_PASSWORD so build-ios.sh can unlock after sleep/lock.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS." >&2
  exit 1
fi

KEYCHAIN="$(bsl_login_keychain_path)"
MARKER="$(bsl_keychain_prepared_marker)"
LOCK_SECONDS="${BSL_KEYCHAIN_LOCK_SECONDS:-86400}"

echo "Keychain: $KEYCHAIN"
echo
echo "This grants Apple codesign tools access to your signing private keys"
echo "without a GUI prompt — required for builds started from your phone."
echo "Your login password is used only for unlock + partition-list locally;"
echo "it is not sent to the PWA or any network service."
echo

PASS="${BSL_KEYCHAIN_PASSWORD:-}"
if [[ -z "$PASS" ]]; then
  # Prefer /dev/tty so this works when stdin is piped.
  if [[ -r /dev/tty ]]; then
    read -r -s -p "Login keychain password: " PASS </dev/tty
    echo >/dev/tty
  else
    read -r -s -p "Login keychain password: " PASS
    echo
  fi
fi
if [[ -z "$PASS" ]]; then
  echo "Password required." >&2
  exit 2
fi

echo "Unlocking keychain…"
if ! security unlock-keychain -p "$PASS" "$KEYCHAIN"; then
  echo "unlock-keychain failed — wrong password?" >&2
  exit 1
fi

echo "Extending unlock window (${LOCK_SECONDS}s)…"
# -lut: lock after N seconds idle; avoid immediate re-lock mid-build
security set-keychain-settings -lut "$LOCK_SECONDS" "$KEYCHAIN" || true

echo "Allowing codesign / Apple tools (partition list)…"
# apple-tool: + apple: cover codesign / productbuild invoked by xcodebuild
if ! security set-key-partition-list \
  -S "apple-tool:,apple:,codesign:" \
  -s \
  -k "$PASS" \
  "$KEYCHAIN"; then
  echo "set-key-partition-list failed." >&2
  echo "If Keychain Access still shows a codesign dialog later, click Always Allow" >&2
  echo "once with a keyboard/mouse attached to this Mac (not via remote click)." >&2
  exit 1
fi

mkdir -p "$(dirname "$MARKER")"
{
  echo "prepared_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "keychain=$KEYCHAIN"
  echo "lock_seconds=$LOCK_SECONDS"
} >"$MARKER"
chmod 600 "$MARKER" 2>/dev/null || true

echo
echo "OK — signing should no longer prompt for Keychain access during builds."
echo "Marker: $MARKER"
echo
echo "Recommended next steps:"
echo "  1. Optional: add BSL_KEYCHAIN_PASSWORD to .env (chmod 600) so builds"
echo "     can unlock after the Mac sleeps or the keychain re-locks."
echo "  2. Run one local build while at the Mac. If a dialog still appears,"
echo "     click Always Allow with a physical input device once."
echo "  3. There is no Apple API to approve that dialog from your iPhone —"
echo "     preparing the keychain (this script) is the couch-friendly path."
echo
echo "Fallback if a rare dialog still blocks you far from the Mac:"
echo "  use a remote desktop app (Screens, Jump Desktop, etc.) — note that"
echo "  some Screen Sharing sessions cannot click Allow (synthetic click block)."
