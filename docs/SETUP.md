# Setup — buildswiftlazily

One-time setup on the **same Mac** that runs your GitHub Actions self-hosted runner and Xcode.

## 1. Apple Developer — register iPhone UDID

Ad Hoc OTA only installs on devices whose UDID is in the provisioning profile.

### Get the UDID

1. Plug the iPhone into the Mac → tap **Trust**.
2. **Xcode → Window → Devices and Simulators → Devices** → select iPhone → copy **Identifier**.
3. Or **Finder** → select iPhone → click the info line until **UDID** appears → copy.

### Register the device

1. Open [Devices](https://developer.apple.com/account/resources/devices/list)
2. **+** → name (e.g. `Isaac iPhone`) → paste UDID → iPhone → Register
3. Create or edit an **Ad Hoc** provisioning profile for your GuideAI App ID and **include this device**
4. On the Mac: **Xcode → Settings → Accounts → Download Manual Profiles**, or rely on `-allowProvisioningUpdates` during build
5. On iPhone:
   - **Settings → Privacy & Security → Developer Mode** → On (reboot if asked)
   - After first install: **Settings → General → VPN & Device Management** → trust your developer certificate if prompted

## 2. Tailscale (Mac + iPhone)

2. Install Tailscale on the **Mac** and **iPhone**; sign into the **same** tailnet
3. On macOS, ensure the **CLI** is available (doctor looks in PATH and `Tailscale.app`):
   - Tailscale menu → **CLI** install, or `brew install tailscale`
4. Admin console → enable **MagicDNS** and **HTTPS Certificates**:  
   https://login.tailscale.com/admin/dns  
   https://login.tailscale.com/admin/settings/features
5. On the Mac, note the hostname:

```bash
tailscale status --self
# e.g. isaac-macbook.tailnet-xxxx.ts.net
```

6. Put that hostname in `.env` as `TS_HOST` / `BSL_TS_HOST` (bootstrap often fills this)

> macOS GUI Tailscale cannot path-serve folders directly. `scripts/serve-ota.sh` runs a local HTTP server and points `tailscale serve` at it.

## 3. GitHub self-hosted runner

1. Repo → **Settings → Actions → Runners → New self-hosted runner** (macOS)
2. Install and start the runner as a service so it survives logout
3. Add labels: `self-hosted`, `macOS` (installer usually adds these). Optional: also add `ios` for clarity — workflows match on `self-hosted` + `macOS`.
4. Ensure the runner user can run `xcodebuild` and access your signing keychain
5. Keep the runner online (LaunchAgent/service) so `macOS validate` / deploy jobs do not sit queued

### Secrets (repo `buildswiftlazily`)

| Secret | Purpose |
|--------|---------|
| `IOS_REPOS_READ_TOKEN` | Fine-grained PAT: **Contents: Read** on personal (and GuideAI) repos |
| Optional signing secrets | Only if you import `.p12` / profiles per job instead of using the Mac login keychain |

For a personal Mac, keeping certs in the login keychain is simplest. Prefer temp-keychain import + cleanup if the machine is shared.

## 4. First-run bootstrap

```bash
./scripts/bootstrap.sh
```

This copies `config/env.example` → `.env` and `repos.example.yaml` → `repos.yaml`, tries to fill `BSL_TS_HOST` from Tailscale, points `BSL_TOOLING_REF` at your current branch if `deploy-ios.yml` is not on `main` yet, runs doctor, and builds the control plane.

Edit `config/repos.yaml`:

- Set GuideAI `repository: owner/GuideAI` (exact slug)
- Optionally set `scheme` / `project_path`

Edit `.env`:

- `BSL_TS_HOST`, `BSL_TEAM_ID`, `GITHUB_TOKEN` or `GH_TOKEN`, `CURSOR_API_KEY`
- `BSL_DEPLOY_ENGINE=local` (default) — builds on this Mac without Actions
- Optional but recommended: `BSL_API_TOKEN` (`openssl rand -hex 24`) — paste into Status → API token on the phone
- For TestFlight: `BSL_ASC_KEY_ID`, `BSL_ASC_ISSUER_ID`, and place `AuthKey_<KEY_ID>.p8` in `~/.appstoreconnect/private_keys/`

Create a Cursor API key: https://cursor.com/dashboard/api

### TestFlight API key (optional but recommended)

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a key (App Manager), download the `.p8` **once**
3. Note Key ID + Issuer ID → put in `.env`
4. `mkdir -p ~/.appstoreconnect/private_keys && mv AuthKey_XXX.p8 ~/.appstoreconnect/private_keys/`

In the PWA, choose **TestFlight** as the install method. After upload, open the TestFlight app (processing can take a few minutes).

## 5. Doctor

```bash
./scripts/doctor.sh
./scripts/validate-macos.sh   # deeper dry-run / host checks
```

Fix anything red before deploying.

## 6. Control plane + Serve

Prefer **local** engine — the UI defaults to it and works even if the Actions runner is idle.

```bash
./scripts/start.sh
```

Or manually:

```bash
cd apps/control-plane && npm start
# other terminal:
./scripts/serve-control.sh
```

Open `https://$BSL_TS_HOST/` on the iPhone (Tailscale connected) → **Share → Add to Home Screen**.

### Install modes in the UI

| Mode | When to use |
|------|-------------|
| **OTA (Tailscale)** | Default couch path — Ad Hoc IPA over your private Tailscale HTTPS |
| **TestFlight** | Anywhere, Apple-hosted — needs ASC API key; slower processing |
| **Direct** | Phone paired to this Mac |
| **OTA + Direct** | Both |

## 7. First GuideAI deploy

> **Important:** GitHub only lists `workflow_dispatch` workflows that exist on the repo’s **default branch**. For the **Actions** engine, merge `deploy-ios.yml` to `main` (or set `BSL_TOOLING_REF`). The **local** engine does not need this.

From the PWA:

1. Pick GuideAI + branch + scheme
2. Install method: OTA or TestFlight
3. Build where: **This Mac (local)**
4. Tap **Build & Install** and watch the live log
5. When ready: tap **Install on this iPhone** (OTA) or open **TestFlight**

## 8. Optional launchd (keep UI online)

Copy `scripts/launchd/com.buildswiftlazily.control.plist.example` to `~/Library/LaunchAgents/`, edit paths, then:

```bash
launchctl load ~/Library/LaunchAgents/com.buildswiftlazily.control.plist
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Serve refused | Install Tailscale **CLI** (app menu → CLI), then `./scripts/serve-control.sh` |
| Install link does nothing | Use **Safari**; confirm Tailscale connected on phone |
| “Untrusted developer” | VPN & Device Management → Trust |
| App installs but won't open | UDID missing from Ad Hoc profile → re-register, rebuild |
| `devicectl` can't find device | Pair over USB/Wi‑Fi; use OTA mode instead |
| Serve refused | `./scripts/serve-ota.sh --serve-only` and check `tailscale serve status` |
| Actions engine 404 | `deploy-ios.yml` must exist on `BSL_TOOLING_REF` (or use **This Mac** local engine) |
| First start fails | `./scripts/bootstrap.sh` then `./scripts/start.sh` |
