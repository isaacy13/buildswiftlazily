#!/usr/bin/env bash
# ttl-sweep.sh — expire OTA/work/builds trees; prune one job's bulky intermediates
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ttl-sweep.sh [--dry-run] [--job ID]

Deletes UUID-named children of:
  $BSL_ARTIFACT_ROOT/www/ota   (published OTA IPAs)
  $BSL_ARTIFACT_ROOT/work      (source checkouts)
  $BSL_ARTIFACT_ROOT/builds    (xcarchive / DerivedData / IPA)

older than BSL_ARTIFACT_TTL_DAYS (default 7). Days <= 0 skips age expiry.

--job ID  Also delete that job's work/ checkout and bulky build intermediates
          (DerivedData, .xcarchive, export/, app/) immediately. Leaves
          www/ota/<id> and small logs until TTL. Duplicate App.ipa under
          builds/ is removed when the OTA copy exists.
          Honors BSL_KEEP_BUILD_INTERMEDIATES=1 (skip immediate prune).
EOF
}

DRY=0
JOB_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --job) JOB_ID="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -n "$JOB_ID" && ! "$JOB_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Invalid --job id" >&2
  exit 2
fi

ROOT="${BSL_ARTIFACT_ROOT:-$HOME/buildswiftlazily/artifacts}"
ROOT="${ROOT/#\~/$HOME}"
DAYS="${BSL_ARTIFACT_TTL_DAYS:-7}"
KEEP="${BSL_KEEP_BUILD_INTERMEDIATES:-0}"

if [[ ! -d "$ROOT" ]]; then
  echo "No artifact root at $ROOT"
  exit 0
fi

export BSL_SWEEP_ROOT="$ROOT"
export BSL_SWEEP_DAYS="$DAYS"
export BSL_SWEEP_DRY="$DRY"
export BSL_SWEEP_JOB="$JOB_ID"
export BSL_SWEEP_KEEP="$KEEP"

python3 <<'PY'
from __future__ import annotations

import os
import re
import shutil
import sys
import time
from pathlib import Path

root = Path(os.environ["BSL_SWEEP_ROOT"]).resolve()
try:
    days = float(os.environ.get("BSL_SWEEP_DAYS") or "7")
except ValueError:
    days = 7.0
dry = os.environ.get("BSL_SWEEP_DRY") == "1"
job = os.environ.get("BSL_SWEEP_JOB") or ""
keep = os.environ.get("BSL_SWEEP_KEEP") == "1"
id_re = re.compile(r"^[A-Za-z0-9_-]+$")
bulky = ("DerivedData", "App.xcarchive", "export", "app")
removed = 0


def under_root(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    return resolved == root or str(resolved).startswith(str(root) + os.sep)


def safe_rm(path: Path, why: str) -> None:
    global removed
    if path.is_symlink():
        print(f"skip symlink {path}", file=sys.stderr)
        return
    if not path.exists():
        return
    if not under_root(path):
        print(f"skip path escape {path}", file=sys.stderr)
        return
    rel = path.relative_to(root)
    action = "DRY_RUN: would remove" if dry else "Removing"
    print(f"{action} {rel} ({why})")
    if not dry:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    removed += 1


if job:
    if not id_re.match(job):
        print("Invalid --job id", file=sys.stderr)
        sys.exit(2)
    if keep:
        print(f"BSL_KEEP_BUILD_INTERMEDIATES=1 — skipping immediate prune of {job}")
    else:
        work = root / "work" / job
        if work.is_dir() and not work.is_symlink():
            safe_rm(work, "job checkout")
        build = root / "builds" / job
        if build.is_dir() and not build.is_symlink():
            for name in bulky:
                p = build / name
                if p.is_dir() and not p.is_symlink():
                    safe_rm(p, "job intermediate")
            ota_ipa = root / "www" / "ota" / job / "App.ipa"
            build_ipa = build / "App.ipa"
            if (
                ota_ipa.is_file()
                and not ota_ipa.is_symlink()
                and build_ipa.is_file()
                and not build_ipa.is_symlink()
            ):
                safe_rm(build_ipa, "duplicate of OTA IPA")

if days > 0:
    cutoff = int(days * 86400)
    now = time.time()
    for sub in ("www/ota", "work", "builds"):
        base = root / sub
        if not base.is_dir() or base.is_symlink():
            continue
        try:
            children = list(base.iterdir())
        except OSError:
            continue
        for child in children:
            if not id_re.match(child.name):
                continue
            if child.is_symlink() or not child.is_dir():
                continue
            try:
                age = int(now - child.stat().st_mtime)
            except OSError:
                continue
            if age > cutoff:
                safe_rm(child, f"age {age}s > {cutoff}s")

if removed == 0:
    print("No expired artifacts to remove")
PY
