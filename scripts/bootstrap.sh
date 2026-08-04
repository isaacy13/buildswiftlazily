#!/usr/bin/env bash
# bootstrap.sh — first-run setup on the Mac so `start` works without tribal knowledge.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

DRY="${BSL_BOOTSTRAP_DRY:-0}"

echo "== buildswiftlazily bootstrap =="

if [[ ! -f config/repos.yaml ]]; then
  cp config/repos.example.yaml config/repos.yaml
  echo "Created config/repos.yaml — set the real GuideAI owner/repo slug."
else
  echo "config/repos.yaml already present"
fi

if [[ ! -f .env ]]; then
  cp config/env.example .env
  chmod 600 .env 2>/dev/null || true
  echo "Created .env from config/env.example (chmod 600)."
else
  echo ".env already present"
fi

# Ensure BSL_API_TOKEN exists (fail-closed API auth)
if ! grep -q '^BSL_API_TOKEN=.\+' .env 2>/dev/null; then
  TOKEN="$(openssl rand -hex 24 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(24))')"
  if [[ "$DRY" == "1" ]]; then
    echo "DRY: would set BSL_API_TOKEN=<generated>"
  else
    python3 - "$TOKEN" <<'PY'
import pathlib, sys
token = sys.argv[1]
p = pathlib.Path(".env")
text = p.read_text() if p.exists() else ""
lines = []
replaced = False
for line in text.splitlines():
    if line.startswith("BSL_API_TOKEN="):
        lines.append(f"BSL_API_TOKEN={token}")
        replaced = True
    else:
        lines.append(line)
if not replaced:
    lines.append(f"BSL_API_TOKEN={token}")
p.write_text("\n".join(lines) + "\n")
print("Generated BSL_API_TOKEN in .env — paste into Status → API token on your phone")
PY
  fi
fi

# Auto-fill Tailscale MagicDNS host when possible
if grep -q '^BSL_TS_HOST=your-mac\.tailnet' .env 2>/dev/null || grep -q '^BSL_TS_HOST=$' .env 2>/dev/null || grep -q '^BSL_TS_HOST=your-mac' .env 2>/dev/null; then
  # shellcheck disable=SC1091
  source "$ROOT/scripts/lib.sh"
  if bsl_find_tailscale >/dev/null && bsl_tailscale status >/dev/null 2>&1; then
    SELF="$(bsl_tailscale status --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || true)"
    if [[ -n "${SELF:-}" ]]; then
      if [[ "$DRY" == "1" ]]; then
        echo "DRY: would set BSL_TS_HOST=$SELF"
      else
        python3 - "$SELF" <<'PY'
import pathlib, sys
host = sys.argv[1]
p = pathlib.Path(".env")
text = p.read_text()
lines = []
replaced = False
for line in text.splitlines():
    if line.startswith("BSL_TS_HOST="):
        lines.append(f"BSL_TS_HOST={host}")
        replaced = True
    else:
        lines.append(line)
if not replaced:
    lines.append(f"BSL_TS_HOST={host}")
p.write_text("\n".join(lines) + "\n")
print(f"Set BSL_TS_HOST={host}")
PY
      fi
    else
      echo "Could not auto-detect Tailscale DNS name — edit BSL_TS_HOST in .env"
    fi
  else
    echo "Tailscale CLI not found/connected — edit BSL_TS_HOST in .env after enabling the CLI"
  fi
fi

# Auto-fill BSL_TEAM_ID from keychain when still placeholder
if grep -q '^BSL_TEAM_ID=XXXXXXXXXX$' .env 2>/dev/null || grep -q '^BSL_TEAM_ID=$' .env 2>/dev/null; then
  # shellcheck disable=SC1091
  source "$ROOT/scripts/lib.sh"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    TEAM_GUESS="$(bsl_guess_team_ids | head -1 || true)"
    if [[ -n "${TEAM_GUESS:-}" ]]; then
      if [[ "$DRY" == "1" ]]; then
        echo "DRY: would set BSL_TEAM_ID=$TEAM_GUESS"
      else
        python3 - "$TEAM_GUESS" <<'PY'
import pathlib, sys
tid = sys.argv[1]
p = pathlib.Path(".env")
lines = []
for line in p.read_text().splitlines():
    if line.startswith("BSL_TEAM_ID="):
        lines.append(f"BSL_TEAM_ID={tid}")
    else:
        lines.append(line)
p.write_text("\n".join(lines) + "\n")
print(f"Set BSL_TEAM_ID={tid} (from codesigning identities — confirm in Apple Developer)")
PY
      fi
    fi
  fi
fi

# Prefer this feature branch for Actions until deploy-ios.yml is on main
if grep -q '^BSL_TOOLING_REF=main$' .env 2>/dev/null; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -n "$BRANCH" && "$BRANCH" != "main" && -f .github/workflows/deploy-ios.yml ]]; then
    if [[ "$DRY" == "1" ]]; then
      echo "DRY: would set BSL_TOOLING_REF=$BRANCH (deploy-ios.yml not on main yet)"
    else
      python3 - "$BRANCH" <<'PY'
import pathlib, sys
ref = sys.argv[1]
p = pathlib.Path(".env")
text = p.read_text()
lines = []
for line in text.splitlines():
    if line.startswith("BSL_TOOLING_REF="):
        lines.append(f"BSL_TOOLING_REF={ref}")
    else:
        lines.append(line)
p.write_text("\n".join(lines) + "\n")
print(f"Set BSL_TOOLING_REF={ref} so Actions engine can find deploy-ios.yml")
PY
    fi
  fi
fi

echo
if [[ "$DRY" == "1" ]]; then
  echo "DRY: skip npm install/build and doctor side effects that need Darwin"
  # Still exercise doctor in dry mode when possible
  ./scripts/doctor.sh || true
  echo
  echo "Bootstrap dry-run OK."
  echo "Next (on your Mac): edit .env + config/repos.yaml, then:"
  echo "  ./scripts/bootstrap.sh && ./scripts/start.sh"
  exit 0
fi

./scripts/doctor.sh || true

echo
echo "[control plane]"
cd apps/control-plane
if [[ ! -d node_modules ]]; then
  npm install
else
  npm install --prefer-offline
fi
npm run build
cd "$ROOT"

echo
echo "== bootstrap complete =="
echo "1. Edit .env — GITHUB_TOKEN, BSL_TEAM_ID, BSL_TS_HOST (if unset), optional ASC + CURSOR keys"
echo "2. Edit config/repos.yaml — real GuideAI slug"
echo "3. Start:  ./scripts/start.sh"
echo "4. Phone (Tailscale on): https://\$BSL_TS_HOST/  → Add to Home Screen → Build"
echo
echo "Default engine is local (this Mac). Actions runner is optional."
