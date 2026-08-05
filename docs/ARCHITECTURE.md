# Architecture

buildswiftlazily is a **single-operator** Mac-hosted control plane plus shell scripts. The phone UI is a static PWA served by that control plane over Tailscale HTTPS.

## Components

| Path | Responsibility |
|------|----------------|
| `apps/control-plane` | TypeScript (Hono) API + Vite PWA. Job store in memory. Serves `/api/*`, static UI, and `/ota/*` artifacts. |
| `scripts/build-ios.sh` | `xcodebuild` archive + export for **iOS or watchOS** (`--platform`). |
| `scripts/serve-ota.sh` | Copy IPA + write `manifest.plist` / install HTML under the artifact www root; ensure Tailscale Serve. |
| `scripts/serve-control.sh` | Point `tailscale serve` at the control plane port. |
| `scripts/upload-testflight.sh` | `xcrun altool` upload with App Store Connect API key. |
| `scripts/install-direct.sh` | `devicectl` install/launch on a paired **iPhone or Apple Watch**. |
| `scripts/prepare-keychain.sh` | One-time unattended codesign Keychain prep. |
| `scripts/bootstrap.sh` / `start.sh` / `doctor.sh` | First-run, launch, and host checks. |
| `.github/workflows/deploy-ios.yml` | Optional remote path: self-hosted Mac runner runs the same scripts. |

## Request path (local engine)

1. PWA `POST /api/deploy` with Bearer `BSL_API_TOKEN`.
2. Control plane validates repo/ref/scheme/paths, acquires deploy gate, creates a job.
3. `runLocalDeploy` downloads a GitHub tarball (symlink-safe extract), runs `build-ios.sh`.
4. For OTA: `serve-ota.sh` publishes under `~/buildswiftlazily/artifacts/www/ota/<uuid>/`.
5. PWA polls `/api/jobs/:id` and shows the install URL (`https://$BSL_TS_HOST/ota/...`).

## Request path (Actions engine)

1. Same API validation, then `workflow_dispatch` on `BSL_TOOLING_REPO` @ `BSL_TOOLING_REF`.
2. Runner checks out tooling + target repo, builds, optionally OTA / direct / TestFlight.
3. Status tab lists recent Actions runs via the GitHub API.

## Trust & network

```text
Public Internet          Tailscale tailnet              Mac loopback
       │                        │                            │
       │     (blocked)          │  HTTPS :443 Serve          │
       ├────────────────────────►  ─────────────────────────►│ :8787 control plane
       │                        │                            │ :8788 fallback static (rare)
```

- Nothing is meant to be reachable without Tailscale membership.
- IPA/manifest URLs cannot practically sit behind browser cookie auth (`itms-services`); Tailscale is the gate.
- API routes (except `/api/health`) require `BSL_API_TOKEN`.

## Config surfaces

| File | Committed? | Role |
|------|------------|------|
| `config/env.example` | yes | Template for `.env` |
| `.env` | **no** | Secrets + host settings |
| `config/repos.example.yaml` | yes | Template for pinned apps |
| `config/repos.yaml` | **no** | Your real `owner/repo` list |

## Out of scope

- Multi-user auth, teams, or cloud hosting of IPAs
- Building for you without a Mac / Xcode / Apple Developer account
- Replacing Xcode signing expertise — automatic signing + Team ID is assumed
