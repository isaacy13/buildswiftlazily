# Setup — buildswiftlazily

One-time setup on the **Mac that has Xcode** (and, if you use the Actions engine, your self-hosted runner).

Examples below use a favorite app named **GuideAI** — replace with your own `owner/repo`, scheme, and bundle id.

## 0. Clone & bootstrap

```bash
git clone https://github.com/YOUR_USER/buildswiftlazily.git   # or this upstream
cd buildswiftlazily
./scripts/bootstrap.sh
```

Bootstrap will:

- Create `.env` from `config/env.example` (`chmod 600`) and generate **`BSL_API_TOKEN`**
- Create `config/repos.yaml` from the example
- Try to fill `BSL_TS_HOST` from Tailscale
- `npm install` + build the control plane
- Run `doctor` (warnings are OK until you finish the steps below)

## 1. Apple Developer — register iPhone UDID

Ad Hoc OTA only installs on devices whose UDID is in the provisioning profile.

### Get the UDID

1. Plug the iPhone into the Mac → tap **Trust**.
2. **Xcode → Window → Devices and Simulators → Devices** → select iPhone → copy **Identifier**.
3. Or **Finder** → select iPhone → click the info line until **UDID** appears → copy.

### Register the device

1. Open [Devices](https://developer.apple.com/account/resources/devices/list)
2. **+** → name → paste UDID → iPhone → Register
3. Create or edit an **Ad Hoc** provisioning profile for your App ID and **include this device**
4. On the Mac: **Xcode → Settings → Accounts → Download Manual Profiles**, or rely on `-allowProvisioningUpdates` during build
5. On iPhone:
   - **Settings → Privacy & Security → Developer Mode** → On (reboot if asked)
   - After first install: **Settings → General → VPN & Device Management** → trust your developer certificate if prompted

## 2. Tailscale (Mac + iPhone)

1. Install Tailscale on the **Mac** and **iPhone**; sign into the **same** tailnet
2. On macOS, ensure the **CLI** is available (doctor looks in PATH and `Tailscale.app`):
   - Tailscale menu → **CLI** install, or `brew install tailscale`
3. Admin console → enable **MagicDNS** and **HTTPS Certificates**:  
   https://login.tailscale.com/admin/dns  
   https://login.tailscale.com/admin/settings/features
4. On the Mac, note the hostname:

```bash
tailscale status --self
# e.g. your-mac.tailnet-xxxx.ts.net
```

5. Put that hostname in `.env` as `BSL_TS_HOST` (bootstrap often fills this)

> macOS GUI Tailscale cannot path-serve folders directly. The scripts run a local HTTP server (or the control plane) and point `tailscale serve` at it. **Do not enable Funnel.**

## 3. Config files

### `config/repos.yaml`

```yaml
repos:
  - id: myapp
    repository: you/YourApp
    display_name: YourApp
    favorite: true
    # scheme: YourApp
    # project_path: .
```

Set `defaults.favorite` to that `id`. Discovery can also list your personal GitHub repos when `GITHUB_TOKEN` is set.

### `.env` (minimum)

| Variable | Required | Notes |
|----------|----------|--------|
| `BSL_TS_HOST` | for OTA | MagicDNS hostname only |
| `BSL_API_TOKEN` | **yes** | Bootstrap generates; paste into PWA Status once |
| `BSL_TEAM_ID` | for signing | 10-character Apple Team ID |
| `GITHUB_TOKEN` | **yes** for builds | Fine-grained: Contents Read on apps you build |
| `CURSOR_API_KEY` | no | [Cursor API](https://cursor.com/dashboard/api) for the Cloud Agents tab |
| `BSL_DEPLOY_ENGINE` | no | `local` (default) or `actions` |
| `BSL_TOOLING_REPO` | Actions only | Your fork, e.g. `you/buildswiftlazily` |

Full template: [`config/env.example`](../config/env.example).

## 4. GitHub self-hosted runner (optional)

Only needed if you set `BSL_DEPLOY_ENGINE=actions` or want CI `macOS validate` on your metal.

1. This repo → **Settings → Actions → Runners → New self-hosted runner** (macOS)
2. Install and start as a service so it survives logout
3. Labels: `self-hosted`, `macOS` (workflows match these)
4. Runner user must run `xcodebuild` and reach your signing keychain

### Repo secrets / vars (Actions engine)

| Name | Purpose |
|------|---------|
| `IOS_REPOS_READ_TOKEN` | Fine-grained PAT: **Contents: Read** on app repos |
| `BSL_TS_HOST` | Secret or var — MagicDNS host for OTA publish |
| `BSL_TEAM_ID` | Secret or var — Team ID |
| `BSL_ASC_*` | TestFlight uploads from the runner |

For a personal Mac, keeping certs in the **login keychain** is simplest. Prefer temp-keychain import + `if: always()` cleanup if the machine is shared.

> GitHub only lists `workflow_dispatch` workflows that exist on the **default branch**. Merge `deploy-ios.yml` to `main`, or set `BSL_TOOLING_REF` to a branch that has it. The **local** engine ignores this.

## 5. TestFlight API key (optional)

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a key (App Manager), download the `.p8` **once**
3. Note Key ID + Issuer ID → `BSL_ASC_KEY_ID` / `BSL_ASC_ISSUER_ID` in `.env`
4. `mkdir -p ~/.appstoreconnect/private_keys && mv AuthKey_XXX.p8 ~/.appstoreconnect/private_keys/`

In the PWA, choose **TestFlight**. Processing can take a few minutes after upload.

## 6. Doctor

```bash
./scripts/doctor.sh
./scripts/validate-macos.sh   # deeper dry-run / host checks
```

Fix anything marked fail before deploying.

## 7. Run the control plane

```bash
./scripts/start.sh
```

Or manually:

```bash
cd apps/control-plane && npm start
# other terminal:
./scripts/serve-control.sh
```

Phone: Tailscale on → `https://$BSL_TS_HOST/` → **Share → Add to Home Screen**.

### First launch checklist in the PWA

1. **Status → API token** — paste `BSL_API_TOKEN` from `.env` (stored in that browser only)
2. Pick your favorite app + branch + scheme
3. Install method: OTA (default) or TestFlight / Direct
4. Build where: **This Mac (local)**
5. **Build & Install** → watch the live log → **Install on this iPhone**

## 8. Optional launchd (keep UI online)

Copy `scripts/launchd/com.buildswiftlazily.control.plist.example` to `~/Library/LaunchAgents/`, edit paths, then:

```bash
launchctl load ~/Library/LaunchAgents/com.buildswiftlazily.control.plist
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `unauthorized` / empty UI data | Paste `BSL_API_TOKEN` in Status; confirm `.env` has the same value |
| Serve refused | Install Tailscale **CLI**, then `./scripts/serve-control.sh` |
| Install link does nothing | Use **Safari**; confirm Tailscale connected on the phone |
| “Untrusted developer” | VPN & Device Management → Trust |
| App installs but won't open | UDID missing from Ad Hoc profile → re-register, rebuild |
| `devicectl` can't find device | Pair over USB/Wi‑Fi; use OTA instead |
| Actions engine 404 | `deploy-ios.yml` must exist on `BSL_TOOLING_REF` (or use **local**) |
| First start fails | `./scripts/bootstrap.sh` then `./scripts/start.sh` |

## Next reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — components and data flow  
- [SECURITY.md](SECURITY.md) — trust model and secret handling  
- [../README.md](../README.md) — overview and cheatsheet
