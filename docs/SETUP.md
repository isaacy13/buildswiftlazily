# Setup — buildswiftlazily

One-time setup on the **Mac with Xcode**. Replace example app names with your `owner/repo`, scheme, and bundle id.

## 0. Clone & bootstrap

```bash
git clone https://github.com/YOUR_USER/buildswiftlazily.git
cd buildswiftlazily
./scripts/bootstrap.sh
```

Creates `.env` (`chmod 600`, generates `BSL_API_TOKEN`), `config/repos.yaml`, fills `BSL_TS_HOST` when Tailscale is up, builds the control plane, runs doctor.

## 1. Apple signing (Ad Hoc / OTA)

OTA and Direct need an **Ad Hoc** signed IPA. TestFlight uses **App Store** signing instead (see §5).

### What you actually need

| Piece | Role |
|-------|------|
| Registered **device UDID** | Must be listed in the Ad Hoc profile |
| **App ID** | Bundle id, e.g. `com.you.YourApp` |
| **Apple Distribution** certificate | Required for Ad Hoc (and App Store). **Not** the same as Apple Development |
| Ad Hoc **provisioning profile** | Ties App ID + Distribution cert + device list |

This repo’s `build-ios.sh` uses **automatic signing** (`-allowProvisioningUpdates`). Prefer letting Xcode create/refresh the profile after the UDID is registered. Manual portal steps are for when automatic fails or you want an explicit profile.

### 1a. Register the iPhone UDID

1. Plug in → Trust.
2. **Xcode → Window → Devices and Simulators → Devices** → copy **Identifier** (or Finder → iPhone → click the info line until UDID shows).
3. [Devices](https://developer.apple.com/account/resources/devices/list) → **+** → paste UDID → iPhone → Register.

On the phone: **Settings → Privacy & Security → Developer Mode** → On.

### 1b. Preferred: automatic signing (matches this repo)

1. Open your app in Xcode once → **Signing & Capabilities** → Team = your paid team → leave **Automatically manage signing** on.
2. Set `BSL_TEAM_ID` in `.env` (10 chars). Find it: [Membership](https://developer.apple.com/account#MembershipDetailsCard), or:

```bash
security find-identity -v -p codesigning
# look for (XXXXXXXXXX) after Apple Distribution / Development
```

3. First local build with this tooling will refresh profiles. If export fails on signing, do §1c once, then rebuild.

### 1c. Manual Ad Hoc profile (portal)

**Why it’s asking for a new certificate:** Ad Hoc profiles can only use an **Apple Distribution** cert. If the team has none (or none you’re allowed to pick), the portal forces creating one. An **Apple Development** cert alone is not enough.

**Create Apple Distribution (once per Mac that holds the private key):**

1. [Certificates](https://developer.apple.com/account/resources/certificates/list) → **+** → **Apple Distribution** → Continue.
2. Create a CSR on this Mac: **Keychain Access → Keychain Access menu → Certificate Assistant → Request a Certificate From a Certificate Authority** → User Email = your Apple ID, Common Name = anything, **Saved to disk** (leave CA Email empty).
3. Upload the `.certSigningRequest` → Continue → **Download** the `.cer` → double-click to install into **login** keychain.
4. Confirm in Keychain → **My Certificates**: `Apple Distribution: …` expands to show a **private key**. If there is no private key, the CSR was made on another machine — redo CSR + cert on *this* Mac.

You may keep an existing Distribution cert if it already appears under My Certificates with a private key. Don’t create extras unless the old one is revoked/expired (limit applies per team).

**Create the Ad Hoc profile:**

1. [Profiles](https://developer.apple.com/account/resources/profiles/list) → **+**.
2. Distribution → **Ad Hoc** → Continue.
3. App ID = your app’s bundle id (or the `XC …` / explicit id Xcode already created) → Continue.
4. Select the **Apple Distribution** certificate from above → Continue.
5. Check your iPhone → Continue → name it → Generate → Download (optional if using automatic signing later).
6. On the Mac: **Xcode → Settings → Accounts → [Team] → Download Manual Profiles**, or drop the `.mobileprovision` onto Xcode / `~/Library/MobileDevice/Provisioning Profiles/`.

### 1d. After first install on device

**Settings → General → VPN & Device Management** → trust the developer cert if prompted.

### 1e. Unattended signing (couch builds — no Keychain password dialogs)

macOS will often prompt **“codesign wants to use … in your keychain”** the first times you sign. **There is no Apple API to approve that dialog from your iPhone** (and remote-desktop “clicks” are often blocked on purpose).

Do this **once on the Mac** so builds started from the PWA never wait on you:

```bash
./scripts/prepare-keychain.sh
```

That unlocks the login keychain, extends the lock timeout, and runs `security set-key-partition-list` so Apple’s `codesign` / xcodebuild tools may use signing keys without a GUI prompt.

Optional — so builds still work after the Mac sleeps and the keychain re-locks — add to `.env` (`chmod 600`):

```bash
BSL_KEYCHAIN_PASSWORD='your-login-keychain-password'
```

`build-ios.sh` unlocks before archive when that variable is set. Doctor and the PWA Setup checklist show whether prepare has been run (`~/.config/buildswiftlazily/keychain-prepared`).

If a dialog still appears **once** after prepare, click **Always Allow** with a keyboard/mouse attached to the Mac (not a synthetic remote click). After that, phone-triggered builds should stay unattended.

### Common signing failures

| Symptom | Cause / fix |
|---------|-------------|
| Portal only offers “create certificate” | No usable **Distribution** cert yet → §1c |
| Cert installs but won’t sign | `.cer` without private key → CSR must be from this Mac |
| IPA installs, app won’t open | UDID not in the **current** Ad Hoc profile → add device, regenerate/refresh profile, rebuild |
| `No signing certificate` / export fail | Sign into Xcode Accounts; set `BSL_TEAM_ID`; ensure Distribution identity in keychain |
| Keychain password / “codesign wants to…” while you’re on the couch | §1e — `./scripts/prepare-keychain.sh` (+ optional `BSL_KEYCHAIN_PASSWORD`) |
| `errSecInteractionNotAllowed` / `-25308` / User interaction is not allowed | Keychain locked or ACL not prepared → §1e |
| `Embed Foundation Extensions` / `PhaseScriptExecution` archive failure | App extension embed phase ordered after Thin Binary / Run Scripts, or codesign sandbox. `build-ios.sh` reorders the phase + sets `ENABLE_USER_SCRIPT_SANDBOXING=NO` and uses a per-build DerivedData. If it still fails: Xcode → Target → **Build Phases** → drag **Embed Foundation Extensions** above Thin Binary / other Run Scripts; confirm every `.appex` target uses the same Team (automatic signing); commit the `pbxproj`. |

## Platforms (iOS + watchOS)

| Kind | How to build here |
|------|-------------------|
| **iPhone app** | Platform **iPhone** (default). Scheme archives `generic/platform=iOS`. |
| **iPhone + companion Watch** | Still use **iPhone**. Archive the iOS scheme that embeds the Watch app — Apple deploys the Watch piece with/after the phone install. |
| **Independent / Watch-only** | Platform **Apple Watch**. Scheme must archive for `generic/platform=watchOS`. Prefer **Direct** to a paired Watch (Developer Mode on). TestFlight usually needs an iOS container scheme (modern Xcode “Watch App” templates include one). |

Register the **Watch UDID** in the Apple Developer portal for Ad Hoc, same as iPhones. Pair the Watch, open it once in **Xcode → Devices and Simulators** so the developer disk image mounts, then Direct install can find it.

Pin a Watch app in `config/repos.yaml`:

```yaml
  - id: mywatch
    repository: you/MyWatchApp
    display_name: MyWatch
    scheme: MyWatch Watch App
    platform: watchos
```

## 2. Tailscale (Mac + iPhone)

1. Same tailnet on Mac and iPhone.
2. Install **CLI** (Tailscale menu → CLI, or `brew install tailscale`). Doctor checks PATH and `Tailscale.app`.
3. Enable **MagicDNS** + **HTTPS Certificates**: [DNS](https://login.tailscale.com/admin/dns), [Features](https://login.tailscale.com/admin/settings/features).
4. Hostname → `.env` as `BSL_TS_HOST` (no `https://`):

```bash
tailscale status --self
# your-mac.tailnet-xxxx.ts.net
```

**Do not enable Funnel.** Serve is loopback → Tailscale HTTPS only.

## 3. Config

### `config/repos.yaml`

```yaml
defaults:
  favorite: myapp
repos:
  - id: myapp
    repository: you/YourApp
    display_name: YourApp
    favorite: true
    # scheme: YourApp
    # project_path: .
```

### `.env` (minimum)

| Variable | Required | Notes |
|----------|----------|--------|
| `BSL_TS_HOST` | OTA | MagicDNS hostname |
| `BSL_API_TOKEN` | **yes** | Bootstrap generates; paste in PWA Status once |
| `BSL_TEAM_ID` | signing | 10-char Team ID |
| `GITHUB_TOKEN` | builds | Contents: Read on app repos |
| `CURSOR_API_KEY` | no | [Cursor API](https://cursor.com/dashboard/api) |
| `BSL_DEPLOY_ENGINE` | no | `local` (default) or `actions` |
| `BSL_TOOLING_REPO` | Actions | Your fork, e.g. `you/buildswiftlazily` |

Full list: [`config/env.example`](../config/env.example).

**GitHub token:** fine-grained PAT — Contents Read on apps you build; add Actions Write on this tooling repo only if using the Actions engine.

## 4. Self-hosted Actions runner (optional)

Only for `BSL_DEPLOY_ENGINE=actions` or metal CI.

1. Repo → **Settings → Actions → Runners → New** (macOS) → install as a service.
2. Labels: `self-hosted`, `macOS`.
3. Same user must reach `xcodebuild` + signing keychain.

| Secret / var | Purpose |
|--------------|---------|
| `IOS_REPOS_READ_TOKEN` | Contents: Read on app repos |
| `BSL_TS_HOST`, `BSL_TEAM_ID` | OTA + signing |
| `BSL_ASC_*` | TestFlight from the runner |

`workflow_dispatch` must exist on the **default branch**, or set `BSL_TOOLING_REF`. Local engine ignores this.

## 5. TestFlight (optional)

App Store signing + ASC API (not Ad Hoc).

1. [App Store Connect API keys](https://appstoreconnect.apple.com/access/integrations/api) → generate (App Manager) → download `.p8` once.
2. `.env`: `BSL_ASC_KEY_ID`, `BSL_ASC_ISSUER_ID`.
3. `mkdir -p ~/.appstoreconnect/private_keys && mv AuthKey_XXX.p8 ~/.appstoreconnect/private_keys/`
4. Ensure GuideAI (or your app) already exists in App Store Connect with a matching bundle id.
5. Bump **CFBundleVersion** (build number) before each upload — duplicates are rejected.

PWA → install method **TestFlight** → Build & upload.

**After upload:** check [App Store Connect → TestFlight → Builds](https://appstoreconnect.apple.com/apps) — not only the TestFlight iPhone app. Status goes Processing → Ready to Test (usually minutes; sometimes longer). Answer **Export Compliance** if ASC asks, or the build can sit for hours.

**Do not Ctrl+C** the Mac terminal that is running `./scripts/start.sh` / the control plane during upload — that aborts `altool` mid-transfer. Leave the Mac awake until the job log shows `TESTFLIGHT_UPLOAD=ok`.

## 6. Doctor

```bash
./scripts/doctor.sh
./scripts/validate-macos.sh
```

Fix **fail** rows before deploying.

## 7. Run

```bash
./scripts/start.sh
```

Phone (Tailscale on) → `https://$BSL_TS_HOST/` → **Add to Home Screen**.

1. **Status → API token** ← `BSL_API_TOKEN` from `.env`
2. Repo / branch / scheme → OTA (or TestFlight / Direct) → engine **This Mac (local)**
3. **Build & Install** → when ready, **Install on this iPhone** (Safari)

### Optional launchd

Copy `scripts/launchd/com.buildswiftlazily.control.plist.example` → `~/Library/LaunchAgents/`, edit paths:

```bash
launchctl load ~/Library/LaunchAgents/com.buildswiftlazily.control.plist
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Portal forces a new certificate for Ad Hoc | Need **Apple Distribution** (§1c); Development cert won’t work |
| `unauthorized` / empty API data | Paste matching `BSL_API_TOKEN` in Status |
| Serve refused | Tailscale **CLI** + `./scripts/serve-control.sh` |
| Install link no-op | Safari + Tailscale connected |
| Untrusted developer | VPN & Device Management → Trust |
| Installs but won’t launch | UDID missing from active Ad Hoc profile → §1a + refresh profile + rebuild |
| `devicectl` finds nothing | Pair USB/Wi‑Fi or use OTA |
| Actions 404 | `deploy-ios.yml` on `BSL_TOOLING_REF`, or use local engine |
| `Could not get GOOGLE_APP_ID` / ARCHIVE FAILED | Gitignored `GoogleService-Info.plist` missing from tarball — set `BSL_CHECKOUT_INJECT` (see `config/env.example`) |
| TestFlight empty after “upload” | Confirm job log has `TESTFLIGHT_UPLOAD=ok`. Check **ASC → TestFlight → Builds**, not only the phone app. Ctrl+C on the Mac shell aborts upload. |
| ASC build stuck Processing / Missing Compliance | Answer Export Compliance in App Store Connect; wait out processing (can exceed 1h). |
| altool auth / missing AuthKey | `AuthKey_<BSL_ASC_KEY_ID>.p8` under `~/.appstoreconnect/private_keys/`; key needs App Manager+ |
| Duplicate build rejected | Bump CFBundleVersion, rebuild, upload again |

## Next

- [ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) · [../README.md](../README.md)
