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

1. Install Tailscale on the **Mac** and **iPhone**; sign into the **same** tailnet
2. Admin console → enable **MagicDNS** and **HTTPS Certificates**:  
   https://login.tailscale.com/admin/dns  
   https://login.tailscale.com/admin/settings/features
3. On the Mac, note the hostname:

```bash
tailscale status --self
# e.g. isaac-macbook.tailnet-xxxx.ts.net
```

4. Put that hostname in `.env` as `TS_HOST` / `BSL_TS_HOST`

> macOS GUI Tailscale cannot path-serve folders directly. `scripts/serve-ota.sh` runs a local HTTP server and points `tailscale serve` at it.

## 3. GitHub self-hosted runner

1. Repo → **Settings → Actions → Runners → New self-hosted runner** (macOS)
2. Install and start the runner as a service so it survives logout
3. Add labels: `self-hosted`, `macOS`, `ios` (workflow requires these)
4. Ensure the runner user can run `xcodebuild` and access your signing keychain

### Secrets (repo `buildswiftlazily`)

| Secret | Purpose |
|--------|---------|
| `IOS_REPOS_READ_TOKEN` | Fine-grained PAT: **Contents: Read** on personal (and GuideAI) repos |
| Optional signing secrets | Only if you import `.p12` / profiles per job instead of using the Mac login keychain |

For a personal Mac, keeping certs in the login keychain is simplest. Prefer temp-keychain import + cleanup if the machine is shared.

## 4. Config files

```bash
cp config/repos.example.yaml config/repos.yaml
cp config/env.example .env
```

Edit `config/repos.yaml`:

- Set GuideAI `repository: owner/GuideAI` (exact slug)
- Optionally set `scheme` / `project_path`

Edit `.env`:

- `BSL_TS_HOST`, `BSL_TEAM_ID`, `GITHUB_TOKEN` or `GH_TOKEN`, `CURSOR_API_KEY`

Create a Cursor API key: https://cursor.com/dashboard/api

## 5. Doctor

```bash
./scripts/doctor.sh
```

Fix anything red before deploying.

## 6. Control plane + Serve

```bash
cd apps/control-plane
npm install
npm run build
npm start
```

In another terminal (or via launchd — see below):

```bash
./scripts/serve-control.sh
```

Open `https://$BSL_TS_HOST/` on the iPhone (Tailscale connected) → **Share → Add to Home Screen**.

## 7. First GuideAI deploy

From GitHub Actions (workflow_dispatch) or the PWA:

- Repository: your GuideAI slug
- Ref: branch you want
- Scheme: GuideAI (or whatever `xcodebuild -list` shows)
- Mode: `ota`

When the job finishes, open the install URL on the phone in **Safari**.

## 8. Optional launchd (keep UI online)

Copy `scripts/launchd/com.buildswiftlazily.control.plist.example` to `~/Library/LaunchAgents/`, edit paths, then:

```bash
launchctl load ~/Library/LaunchAgents/com.buildswiftlazily.control.plist
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Install link does nothing | Use **Safari**; confirm Tailscale connected on phone |
| “Untrusted developer” | VPN & Device Management → Trust |
| App installs but won't open | UDID missing from Ad Hoc profile → re-register, rebuild |
| `devicectl` can't find device | Pair over USB/Wi‑Fi; use OTA mode instead |
| Serve refused | `./scripts/serve-ota.sh --serve-only` and check `tailscale serve status` |
