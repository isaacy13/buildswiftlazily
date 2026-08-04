#!/usr/bin/env bash
# ttl-sweep.sh — delete OTA artifacts older than BSL_ARTIFACT_TTL_DAYS
set -euo pipefail

ROOT="${BSL_ARTIFACT_ROOT:-$HOME/buildswiftlazily/artifacts}"
ROOT="${ROOT/#\~/$HOME}"
DAYS="${BSL_ARTIFACT_TTL_DAYS:-7}"
WWW="$ROOT/www/ota"

[[ -d "$WWW" ]] || exit 0

now=$(date +%s)
cutoff=$((DAYS * 86400))

find "$WWW" -mindepth 1 -maxdepth 1 -type d | while read -r dir; do
  mtime=$(stat -f %m "$dir" 2>/dev/null || stat -c %Y "$dir" 2>/dev/null || echo "$now")
  age=$((now - mtime))
  if [[ "$age" -gt "$cutoff" ]]; then
    echo "Removing expired artifact $(basename "$dir") (age ${age}s)"
    rm -rf "$dir"
  fi
done
