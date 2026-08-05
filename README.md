# buildswiftlazily

Build and install your own iOS apps from the couch.

Open a small PWA on your **iPhone** (or Mac), pick a repo/branch, choose **iPhone** or **Apple Watch**, optionally peek at recent **Cursor Cloud Agent** threads, tap **Build & Install**. The IPA lands on your phone or Watch over **Tailscale OTA**, a **paired device**, or **TestFlight**.

Default path: builds run **locally on your Mac** (no Actions runner required). You can optionally dispatch to a self-hosted GitHub Actions Mac runner.

> Personal, single-operator tooling. Not multi-tenant SaaS. Network trust is **your Tailscale tailnet** plus an API token — see [docs/SECURITY.md](docs/SECURITY.md).

## Why this exists

Shipping a personal iOS build usually means: open Xcode, wait, remember signing, AirDrop or cable the phone, or wait on TestFlight. This repo is a thin control plane + scripts so you can do the same loop from the couch while Tailscale keeps IPAs off the public internet.

## Requirements

| Need | Notes |
|------|--------|
| **Mac** with Xcode | Control plane and `xcodebuild` live here |
| **Apple Developer** account | Ad Hoc (OTA/direct) and/or App Store Connect (TestFlight) |
| **Tailscale** on Mac + iPhone | Same tailnet; MagicDNS + HTTPS certs for Serve |
| **Node.js 22+** | Control plane |
| **GitHub token** | Read source (and Actions write if you use the Actions engine) |
| Optional: **Cursor API key** | Cloud Agent prompts in the PWA |
| Optional: **self-hosted Actions runner** | Only if you choose the Actions engine |

## How it fits together

```text
 iPhone (Tailscale)                    Mac (your machine)
 ┌──────────────────┐                  ┌─────────────────────────────┐
 │ PWA  https://…   │  Tailscale Serve │  control plane :8787        │
 │ Build & Install  │ ───────────────► │  local xcodebuild  or       │
 │ Install link     │ ◄─── IPA/OTA ─── │  workflow_dispatch → runner │
 └──────────────────┘                  └─────────────────────────────┘
```

| Piece | Role |
|-------|------|
| **Control plane** (`apps/control-plane`) | Hono API + mobile PWA; binds `127.0.0.1` only |
| **Scripts** (`scripts/`) | `build-ios`, OTA serve, TestFlight upload, doctor, bootstrap |
| **Config** | `.env` (secrets) + `config/repos.yaml` (pinned apps) — both gitignored after copy |
| **Workflow** (optional) | `.github/workflows/deploy-ios.yml` on a self-hosted `macOS` runner |

## Quick start

```bash
git clone https://github.com/isaacy13/buildswiftlazily.git
cd buildswiftlazily
./scripts/bootstrap.sh
```

Bootstrap copies templates, generates `BSL_API_TOKEN`, tries to fill `BSL_TS_HOST` from Tailscale, and builds the control plane.

Then edit:

1. **`config/repos.yaml`** — set your app’s `owner/repo` (examples use a favorite called GuideAI; replace with yours)
2. **`.env`** — `BSL_TEAM_ID`, `GITHUB_TOKEN`, Cursor key if you want it; confirm `BSL_TS_HOST` and `BSL_API_TOKEN`

```bash
./scripts/doctor.sh          # fix anything red
./scripts/start.sh           # API + Tailscale Serve
```

On the phone (Tailscale connected):

1. Open `https://$BSL_TS_HOST/`
2. **Share → Add to Home Screen**
3. Status → paste **API token** from `.env` (`BSL_API_TOKEN`) once
4. Pick repo / branch / scheme → **Build & Install**

Full checklist (Apple Distribution vs Ad Hoc, UDID, TestFlight, runner): **[docs/SETUP.md](docs/SETUP.md)**.

## Install modes

| Want | Choose in the PWA |
|------|-------------------|
| Instant install off home Wi‑Fi | **OTA** + Tailscale on the phone |
| Install anywhere via Apple | **TestFlight** (ASC API key + `.p8`) |
| USB / Wi‑Fi paired to this Mac | **Direct** (`devicectl`) — iPhone or Apple Watch |
| Independent watchOS app | Platform **Apple Watch** + Direct (or TestFlight with a container scheme) |
| Actions runner offline / idle | Engine = **This Mac (local)** (default) |

## Configuration cheatsheet

| Variable / file | Purpose |
|-----------------|--------|
| `BSL_TS_HOST` | MagicDNS name of the Mac (no `https://`) |
| `BSL_API_TOKEN` | Required API auth; bootstrap generates one |
| `BSL_TEAM_ID` | 10-char Apple Team ID for signing |
| `BSL_KEYCHAIN_PASSWORD` | Optional; unlocks login keychain after sleep for unattended codesign ([docs/SETUP.md](docs/SETUP.md) §1e) |
| `GITHUB_TOKEN` | Contents read (+ Actions write if dispatching) |
| `BSL_DEPLOY_ENGINE` | `local` (default) or `actions` |
| `BSL_TOOLING_REPO` / `BSL_TOOLING_REF` | Where `deploy-ios.yml` lives (Actions engine only) |
| `config/repos.yaml` | Pinned apps, schemes, favorites |

See `config/env.example` for the full list.

## Security (short version)

- Control plane listens on **loopback**; expose it only with **`tailscale serve`** (never Funnel).
- **`BSL_API_TOKEN` is required** unless you explicitly set `BSL_ALLOW_INSECURE_API=1` (smoke/dev only).
- Ad Hoc installs are limited to registered **UDIDs**.
- Secrets stay in `.env` / Keychain / Actions secrets — not in the browser bundle.

Details and threat model: **[docs/SECURITY.md](docs/SECURITY.md)**.

## Forking

If you fork this for your own Mac:

1. Change `BSL_TOOLING_REPO` to `youruser/buildswiftlazily` (or disable the Actions engine and stay on `local`).
2. Rotate every token and regenerate signing material — do not reuse anything from someone else’s machine.
3. Replace example repo slugs in `config/repos.yaml`.

## Development & tests

```bash
cd apps/control-plane && npm ci && npm test && npm run build
# from repo root:
./scripts/smoke-api.sh
./scripts/test-scripts.sh
./scripts/validate-macos.sh
```

Control plane notes: [apps/control-plane/README.md](apps/control-plane/README.md).

## Docs

| Doc | Contents |
|-----|----------|
| [docs/SETUP.md](docs/SETUP.md) | End-to-end Mac + phone setup |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust boundaries, secrets, reporting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components and data flow |

## License

[MIT](LICENSE) — © Isaac Yeang.
