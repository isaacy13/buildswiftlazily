# Control plane

TypeScript (Hono) API + Vite mobile PWA.

## Develop

```bash
cp ../../config/env.example ../../.env
cp ../../config/repos.example.yaml ../../config/repos.yaml
# edit GuideAI slug + tokens

npm install
npm run dev          # API on :8787
# optional: npm run build:web && open dist via API static
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

```bash
npm run build
npm start
./scripts/serve-control.sh
```

Or use the launchd example under `scripts/launchd/`.
