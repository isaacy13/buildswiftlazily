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
cp config/env.example .env
cp config/repos.example.yaml config/repos.yaml
# edit: GuideAI owner/repo, BSL_TS_HOST, BSL_TEAM_ID, GITHUB_TOKEN, CURSOR_API_KEY
# for TestFlight also: BSL_ASC_KEY_ID, BSL_ASC_ISSUER_ID + AuthKey_*.p8

./scripts/doctor.sh
cd apps/control-plane && npm install && npm run build && npm start
# other terminal:
./scripts/serve-control.sh
```

Phone: Tailscale on → `https://$BSL_TS_HOST/` → Add to Home Screen → **Build**.

Full checklist: **[docs/SETUP.md](docs/SETUP.md)** (includes UDID + TestFlight API key).

## Tests (no Mac runner required)

```bash
cd apps/control-plane && npm test && npm run build
./scripts/smoke-api.sh
./scripts/test-scripts.sh
```

## Security

Tailscale-only UI/IPAs. Secrets stay on the Mac. See **[docs/SECURITY.md](docs/SECURITY.md)**.
