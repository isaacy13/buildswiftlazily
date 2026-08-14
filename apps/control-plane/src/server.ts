import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import path from "node:path";
import { loadEnv, loadRepoConfig, REPO_ROOT } from "./config.js";
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

function runArtifactSweep(reason: string): void {
  const script = path.join(REPO_ROOT, "scripts/ttl-sweep.sh");
  execFile(
    "bash",
    [script],
    {
      env: {
        ...process.env,
        BSL_ARTIFACT_ROOT: env.artifactRoot,
        BSL_ARTIFACT_TTL_DAYS: String(env.artifactTtlDays),
      },
      timeout: 180_000,
    },
    (err, stdout, stderr) => {
      const out = `${stdout || ""}${stderr || ""}`.trim();
      if (out) {
        for (const line of out.split("\n").slice(0, 20)) {
          logInfo(`ttl-sweep (${reason}): ${line}`);
        }
      }
      if (err) logInfo(`ttl-sweep (${reason}): ${err.message}`);
    },
  );
}

runArtifactSweep("startup");
setInterval(() => runArtifactSweep("hourly"), 60 * 60 * 1000).unref();

serve({ fetch: app.fetch, port: env.controlPort, hostname: "127.0.0.1" }, () => {
  console.log(
    `buildswiftlazily on http://127.0.0.1:${env.controlPort} (engine=${env.deployEngine})`,
  );
});
