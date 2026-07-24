# Security model — buildswiftlazily

Personal, single-operator tooling. Threat model is “don’t leak my IPAs, tokens, or signing material,” not multi-tenant SaaS.

## Trust boundaries

| Layer | Control |
|-------|---------|
| Network | **Tailscale Serve only** (not Funnel). UI and IPA/manifest URLs are unreachable off-tailnet. |
| Apple install | **Ad Hoc** provisioning — only registered UDIDs can install. |
| Secrets | Cursor API key, GitHub PAT, signing material stay on the Mac / GitHub Actions secrets. Never shipped to the browser bundle. |
| Build inputs | Repo allowlist / personal-account scope; sanitize `ref` and paths; no shell interpolation of untrusted strings. |
| Audit | Every deploy creates a GitHub Actions run. |

## Why not Cloudflare Access in front of IPAs

Apple’s `itms-services` installer fetches the manifest **without** browser Access cookies/JWTs. Putting Access in front of IPA/manifest URLs commonly breaks OTA. Network-layer auth (Tailscale) avoids that.

## Secret handling

- Store tokens in `.env` (`chmod 600`) or macOS Keychain — `.env` is gitignored
- Prefer fine-grained PAT: Contents Read on needed repos; Actions Write only on `buildswiftlazily` if dispatching remotely
- If importing `.p12` in CI on this self-hosted runner, use a temp keychain and **always** delete it in an `if: always()` step
- Never echo secrets in logs; redact in control-plane logging

## Artifact hygiene

- Store IPAs under a local artifacts directory (default `~/buildswiftlazily/artifacts`)
- Prefer unguessable artifact IDs (UUIDs)
- TTL sweeper deletes old builds (default 7 days)
- Do not upload IPAs to public GitHub Releases

## Runner hardening (recommended)

- Run the Actions runner under a dedicated macOS user if others use the machine
- Keep the Mac awake / prevent sleep during builds, or use `caffeinate` in scripts
- Tailscale ACLs: only your user/devices can reach the Serve port
- Don’t expose the Actions runner webhook beyond GitHub’s outbound model

## What this does **not** protect against

- Someone already on your Tailscale identity / stolen laptop session
- Malicious code in a branch you voluntarily build (treat branches like local `xcodebuild`)
- Compromised Apple Developer account

## Reporting

This is a private personal repo. If you fork it, rotate all tokens and regenerate signing material before first use.
