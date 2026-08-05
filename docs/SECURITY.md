# Security model — buildswiftlazily

Personal, **single-operator** tooling. Threat model is “don’t leak my IPAs, tokens, or signing material,” not multi-tenant SaaS.

This repository is **public**. Forks and clones must bring their **own** secrets and Apple material — never copy `.env`, keychains, or PATs from another machine.

## Trust boundaries

| Layer | Control |
|-------|---------|
| Network | **Tailscale Serve only** (not Funnel). UI and IPA/manifest URLs are unreachable off-tailnet. Control plane binds **127.0.0.1** only. |
| App API | **`BSL_API_TOKEN` required** (Bearer / `X-BSL-Token`) on all `/api/*` except health. Opt out only with explicit `BSL_ALLOW_INSECURE_API=1` (smoke/dev). Same-origin only (no open CORS). |
| Apple install | **Ad Hoc** provisioning — only registered UDIDs can install. |
| Secrets | Cursor API key, GitHub PAT, signing material stay on the Mac / GitHub Actions secrets. Never shipped to the browser bundle. |
| Build inputs | Sanitize `ref`, scheme, paths, titles; no shell interpolation of untrusted strings (Actions inputs via `env:` only). |
| Audit | Every Actions deploy creates a GitHub Actions run; local jobs keep redacted logs. |

## Why not Cloudflare Access in front of IPAs

Apple’s `itms-services` installer fetches the manifest **without** browser Access cookies/JWTs. Putting Access in front of IPA/manifest URLs commonly breaks OTA. Network-layer auth (Tailscale) avoids that.

## Secret handling

- Store tokens in `.env` (`chmod 600`) or macOS Keychain — `.env` is gitignored
- Prefer fine-grained PAT: Contents Read on needed repos; Actions Write only on your `buildswiftlazily` fork if dispatching remotely
- Set `BSL_API_TOKEN` (`openssl rand -hex 24`; bootstrap auto-generates) and paste it once in the PWA Status tab (stored in `localStorage` on that device)
- Optional `BSL_KEYCHAIN_PASSWORD` unlocks the login keychain for local `xcodebuild` after sleep — treat it like the Mac login secret (`.env` only, never the browser). Prefer `./scripts/prepare-keychain.sh` so codesign ACLs do not need a GUI prompt. When set, `build-ios.sh` unlocks then **unsets** the variable before `xcodebuild` so Run Script phases do not inherit it; the control plane also omits it from env for install/OTA/TestFlight child processes; job logs redact it.
- Do **not** set `BSL_ALLOW_INSECURE_API=1` on a Tailscale-exposed Mac — that re-enables cross-site deploy CSRF from any page you browse while on-tailnet
- GitHub source tarballs are listed before extract (reject symlinks/hardlinks/`..`); post-extract walk denies symlink escapes
- If importing `.p12` in CI on a self-hosted runner, use a temp keychain and **always** delete it in an `if: always()` step
- Never echo secrets in logs; control-plane redacts tokens in console + job logs
- Never enable **Tailscale Funnel** for this Serve endpoint

## Artifact hygiene

- Store IPAs under a local artifacts directory (default `~/buildswiftlazily/artifacts`)
- Prefer unguessable artifact IDs (UUIDs)
- TTL sweeper deletes old builds (default 7 days)
- Do not upload IPAs to public GitHub Releases
- `/ota/<uuid>/` is intentionally unauthenticated (Apple’s installer cannot send API tokens). Tailscale is the gate; UUIDs are unguessable. Anyone already on your tailnet who learns a UUID can fetch that IPA
- Prefer the **local** deploy engine on a public tooling fork. Actions logs/summaries must not print full OTA URLs (MagicDNS host + UUID); the workflow redacts those lines. Keep `BSL_TS_HOST` out of public repo Variables when possible (use environment secrets on a private fork if you rely on Actions OTA)

## Runner hardening (recommended)

- Run the Actions runner under a dedicated macOS user if others use the machine
- Keep the Mac awake / prevent sleep during builds, or use `caffeinate` in scripts
- Tailscale ACLs: only your user/devices can reach the Serve port
- Don’t expose the Actions runner webhook beyond GitHub’s outbound model
- Single-flight deploy gate: only one local build at a time (+ short cooldown)

## What this does **not** protect against

- Someone with your Tailscale identity **and** the device-local API token / stolen laptop session
- Malicious code in a branch you voluntarily build (treat branches like local `xcodebuild`)
- Compromised Apple Developer account
- Publishing this tooling publicly does **not** publish your IPAs — but a misconfigured Funnel or missing API token would

## Fork checklist

1. Generate a new `BSL_API_TOKEN`; never reuse another operator’s `.env`
2. Create your own GitHub PAT / Cursor key / ASC `.p8`
3. Set `BSL_TOOLING_REPO` to your fork
4. Regenerate or use your own Apple signing identities and profiles

## Reporting vulnerabilities

Please report security issues privately via GitHub **Security Advisories** on this repository (Prefer “Report a vulnerability”), or contact the maintainer through GitHub. Do not open public issues that include exploit details or secrets.

Please include: affected version/commit, reproduction steps, and impact. We aim to acknowledge reports promptly; this is a small personal project, so fix timelines vary.
