import { serve } from "@hono/node-server";
import { loadEnv, loadRepoConfig } from "./config.js";
import { createApp } from "./app.js";
import { globalJobs } from "./jobs.js";
import { logInfo } from "./security.js";

const env = loadEnv();
const repoConfig = loadRepoConfig();
const { app } = createApp({ env, repoConfig, jobs: globalJobs });

if (!env.apiToken && !env.allowInsecureApi) {
  logInfo(
    "WARN: BSL_API_TOKEN unset — API will reject requests until you set a token (or BSL_ALLOW_INSECURE_API=1).",
  );
} else if (!env.apiToken && env.allowInsecureApi) {
  logInfo(
    "WARN: BSL_ALLOW_INSECURE_API=1 — API has no app-layer auth (Tailscale/loopback only).",
  );
}

serve({ fetch: app.fetch, port: env.controlPort, hostname: "127.0.0.1" }, () => {
  console.log(
    `buildswiftlazily on http://127.0.0.1:${env.controlPort} (engine=${env.deployEngine})`,
  );
});
