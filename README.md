# buildswiftlazily

Couch-side iOS build & deploy for your self-hosted Mac runner.

Open a mobile PWA on your **iPhone** or **MacBook**, pick any personal GitHub branch that has an iOS app (GuideAI by default), glance at your recent **Cursor Cloud Agent** prompts, tap **Build & Install**, and get an Ad Hoc build onto your phone — even when you're not on the same Wi‑Fi as your Mac.

## How it works

```text
iPhone / MacBook  --Tailscale-->  your Mac (Xcode + Actions runner)
                                   ├─ control plane PWA
                                   ├─ Ad Hoc OTA over Tailscale HTTPS
                                   └─ optional direct `devicectl` install
```

- **OTA (default):** Ad Hoc `.ipa` + `itms-services://` install page, served privately via Tailscale Serve
- **Direct:** `xcrun devicectl` install + launch when the phone is paired to the Mac
- **$0 incremental:** self-hosted Actions minutes, Tailscale personal, no Diawi/VPS

## Quick start (on your Mac)

1. Read **[docs/SETUP.md](docs/SETUP.md)** (Tailscale, UDID, Ad Hoc signing, runner labels)
2. Copy config:

```bash
cp config/repos.example.yaml config/repos.yaml
cp config/env.example .env
# edit: GuideAI owner/repo, TEAM_ID, Tailscale host, API keys
```

3. Check the machine:

```bash
./scripts/doctor.sh
```

4. Start the control plane:

```bash
cd apps/control-plane && npm install && npm run dev
# then: ./scripts/serve-control.sh   # Tailscale Serve → UI
```

5. On iPhone: install Tailscale, open `https://<your-mac>.tailnet.ts.net/`, Add to Home Screen.

## Manual deploy (no UI)

```bash
gh workflow run deploy-ios.yml \
  -f repository=YOUR/GuideAI \
  -f ref=main \
  -f scheme=GuideAI \
  -f deploy_mode=ota
```

## Security

See **[docs/SECURITY.md](docs/SECURITY.md)**. UI and IPAs are Tailscale-only; secrets never go to the browser.

## Repo layout

| Path | Purpose |
|------|---------|
| `apps/control-plane/` | API + mobile PWA |
| `scripts/` | build / OTA / direct install / doctor |
| `.github/workflows/deploy-ios.yml` | self-hosted deploy job |
| `config/` | repos allowlist + favorites |
| `docs/` | setup & security |
