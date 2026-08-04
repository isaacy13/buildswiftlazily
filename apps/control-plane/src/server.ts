import { serve } from "@hono/node-server";
import { loadEnv, loadRepoConfig } from "./config.js";
import { createApp } from "./app.js";
import { globalJobs } from "./jobs.js";

const env = loadEnv();
const repoConfig = loadRepoConfig();
const { app } = createApp({ env, repoConfig, jobs: globalJobs });

serve({ fetch: app.fetch, port: env.controlPort, hostname: "127.0.0.1" }, () => {
  console.log(
    `buildswiftlazily on http://127.0.0.1:${env.controlPort} (engine=${env.deployEngine})`,
  );
});
