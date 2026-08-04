# Control plane

TypeScript (Hono) API + Vite mobile PWA. Listens on `127.0.0.1` only; expose via Tailscale Serve from the repo root scripts.

See the root [README](../../README.md), [docs/SETUP.md](../../docs/SETUP.md), and [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Develop

```bash
cp ../../config/env.example ../../.env
cp ../../config/repos.example.yaml ../../config/repos.yaml
# edit app slug + tokens (BSL_API_TOKEN is required unless BSL_ALLOW_INSECURE_API=1)

npm install
npm run dev          # API on :8787
```

In another terminal from repo root:

```bash
./scripts/serve-control.sh
```

## Test

```bash
npm test
npm run build
```

## Production on Mac

Prefer from repo root:

```bash
./scripts/start.sh
```

Or:

```bash
npm run build
npm start
./scripts/serve-control.sh
```

Launchd example: `scripts/launchd/com.buildswiftlazily.control.plist.example`.
