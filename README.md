# buildswiftlazily

Build iOS apps from the couch. Open this on your **iPhone** or **MacBook**, pick a branch (GuideAI-first), peek at recent **Cursor Cloud Agent** prompts, tap **Build & Install**.

Works **even when the GitHub Actions runner is down** — by default builds run **locally on your Mac** (where the control plane lives). Optional: dispatch to self-hosted Actions. Install via **Tailscale OTA**, **paired device**, or **TestFlight**.

## 30-second mental model

| Want | Choose |
|------|--------|
| Instant couch install (off home Wi‑Fi) | **OTA** + Tailscale on phone |
| Install anywhere via Apple | **TestFlight** |
| USB/Wi‑Fi paired to Mac | **Direct** |
| Actions runner offline | Engine = **This Mac (local)** |

## Quick start (Mac)

```bash
./scripts/bootstrap.sh
# edit .env + config/repos.yaml (GuideAI slug, GITHUB_TOKEN, BSL_TEAM_ID;
# for TestFlight: BSL_ASC_* + AuthKey_*.p8)

./scripts/start.sh
```

Phone: Tailscale on → `https://$BSL_TS_HOST/` → Add to Home Screen → **Build**.

Full checklist: **[docs/SETUP.md](docs/SETUP.md)** (includes UDID + TestFlight API key).

## Tests

```bash
# Linux + Mac
cd apps/control-plane && npm test && npm run build
./scripts/smoke-api.sh
./scripts/test-scripts.sh
./scripts/validate-macos.sh

# Self-hosted Mac runner also runs workflow: macOS validate
```

## Security

Tailscale-only UI/IPAs. Secrets stay on the Mac. See **[docs/SECURITY.md](docs/SECURITY.md)**.
