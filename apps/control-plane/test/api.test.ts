import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createApp } from "../src/app.js";
import { JobStore } from "../src/jobs.js";
import { runLocalDeploy, injectCheckoutFiles, runScript } from "../src/localDeploy.js";
import type { Env } from "../src/config.js";

function testEnv(overrides: Partial<Env> = {}): Env {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bsl-"));
  return {
    tsHost: "mac.tailnet.ts.net",
    controlPort: 8799,
    otaPort: 8788,
    teamId: "TEAM123456",
    artifactRoot,
    artifactTtlDays: 7,
    githubToken: "",
    cursorApiKey: "",
    guideAiRepo: "isaacy13/GuideAI",
    toolingRepo: "isaacy13/buildswiftlazily",
    toolingRef: "main",
    deployEngine: "local",
    apiToken: "",
    // Tests exercise handlers without a token unless a case opts into auth.
    allowInsecureApi: true,
    ...overrides,
  };
}

const repoConfig = {
  discovery: { mode: "personal" as const, max_repos: 10, scan_depth: 4 },
  defaults: {
    favorite: "guideai",
    deploy_mode: "ota" as const,
    configuration: "Release",
  },
  repos: [
    {
      id: "guideai",
      repository: "isaacy13/GuideAI",
      display_name: "GuideAI",
      favorite: true,
      scheme: "GuideAI",
    },
  ],
};

test("GET /api/health and /api/setup", async () => {
  const { app } = createApp({ env: testEnv(), repoConfig });
  const health = await app.request("/api/health");
  assert.equal(health.status, 200);
  const h = await health.json();
  assert.equal(h.ok, true);
  assert.equal(h.deployEngine, "local");

  const setup = await app.request("/api/setup");
  assert.equal(setup.status, 200);
  const s = await setup.json();
  assert.ok(Array.isArray(s.items));
  assert.ok(s.items.some((i: { id: string }) => i.id === "github"));
  assert.ok(s.items.some((i: { id: string }) => i.id === "keychain"));
});

test("GET /api/repos without token returns pinned GuideAI", async () => {
  const { app } = createApp({ env: testEnv(), repoConfig });
  const res = await app.request("/api/repos");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.repos.some((r: { full_name: string }) => r.full_name === "isaacy13/GuideAI"));
  assert.ok(data.warning);
});

test("POST /api/deploy local starts job and dry-run succeeds", async () => {
  process.env.BSL_DRY_RUN = "1";
  const jobs = new JobStore();
  const env = testEnv();
  const { app } = createApp({ env, repoConfig, jobs });
  const res = await app.request("/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repository: "isaacy13/GuideAI",
      ref: "main",
      scheme: "GuideAI",
      deploy_mode: "ota",
      engine: "local",
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.engine, "local");
  assert.ok(body.jobId);

  // Wait for async job
  let job = jobs.get(body.jobId)!;
  for (let i = 0; i < 40 && job.status !== "succeeded" && job.status !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    job = jobs.get(body.jobId)!;
  }
  assert.equal(job.status, "succeeded", job.logs.join("\n"));
  assert.ok(job.installUrl?.includes("/ota/"));
  delete process.env.BSL_DRY_RUN;
});

test("local TestFlight dry-run job", async () => {
  process.env.BSL_DRY_RUN = "1";
  const jobs = new JobStore();
  const env = testEnv();
  const job = jobs.create({
    engine: "local",
    repository: "isaacy13/GuideAI",
    ref: "main",
    scheme: "GuideAI",
    deployMode: "testflight",
  });
  await runLocalDeploy(env, jobs, job.id, {
    repository: "isaacy13/GuideAI",
    ref: "main",
    scheme: "GuideAI",
    deploy_mode: "testflight",
  });
  const done = jobs.get(job.id)!;
  assert.equal(done.status, "succeeded", done.logs.join("\n"));
  assert.ok(done.testflightNote);
  delete process.env.BSL_DRY_RUN;
});

test("config exposes testflight mode", async () => {
  const { app } = createApp({ env: testEnv(), repoConfig });
  const res = await app.request("/api/config");
  const data = await res.json();
  assert.ok(data.modes.includes("testflight"));
  assert.ok(data.engines.includes("local"));
});

test("injectCheckoutFiles copies dest=src into checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bsl-inj-"));
  const src = path.join(root, "GoogleService-Info.plist");
  fs.writeFileSync(src, "plist");
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  const copied = injectCheckoutFiles(
    checkout,
    `ios/GuideAI/GoogleService-Info.plist=${src}`,
  );
  assert.equal(copied.length, 1);
  assert.equal(
    fs.readFileSync(
      path.join(checkout, "ios/GuideAI/GoogleService-Info.plist"),
      "utf8",
    ),
    "plist",
  );
});

test("API token rejects unauthorized deploy", async () => {
  const { app } = createApp({
    env: testEnv({ apiToken: "test-secret-token-12", allowInsecureApi: false }),
    repoConfig,
  });
  const denied = await app.request("/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repository: "isaacy13/GuideAI",
      ref: "main",
      scheme: "GuideAI",
      engine: "local",
    }),
  });
  assert.equal(denied.status, 401);

  const health = await app.request("/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).apiAuthRequired, true);

  process.env.BSL_DRY_RUN = "1";
  const ok = await app.request("/api/deploy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-secret-token-12",
    },
    body: JSON.stringify({
      repository: "isaacy13/GuideAI",
      ref: "main",
      scheme: "GuideAI",
      deploy_mode: "ota",
      engine: "local",
    }),
  });
  assert.equal(ok.status, 200);
  delete process.env.BSL_DRY_RUN;
});

test("API locked when token missing and insecure not allowed", async () => {
  const { app } = createApp({
    env: testEnv({ apiToken: "", allowInsecureApi: false }),
    repoConfig,
  });
  const res = await app.request("/api/repos");
  assert.equal(res.status, 401);
  const health = await app.request("/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).apiAuthRequired, true);
});

test("deploy rejects unsafe scheme", async () => {
  const { app } = createApp({ env: testEnv(), repoConfig });
  const res = await app.request("/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repository: "isaacy13/GuideAI",
      ref: "main",
      scheme: "GuideAI; rm -rf /",
      engine: "local",
    }),
  });
  assert.equal(res.status, 400);
});

test("second deploy while inflight returns 429 with reattach jobId", async () => {
  process.env.BSL_DRY_RUN = "1";
  const jobs = new JobStore();
  // Slow the first job by stubbing nothing — gate holds until finally().
  // Start one deploy, then immediately POST again before it finishes.
  const { app } = createApp({ env: testEnv(), repoConfig, jobs });

  const first = await app.request("/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repository: "isaacy13/GuideAI",
      ref: "main",
      scheme: "GuideAI",
      deploy_mode: "ota",
      engine: "local",
    }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.ok(firstBody.jobId);

  const second = await app.request("/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repository: "isaacy13/GuideAI",
      ref: "main",
      scheme: "GuideAI",
      deploy_mode: "ota",
      engine: "local",
    }),
  });
  assert.equal(second.status, 429);
  const blocked = await second.json();
  assert.match(blocked.error, /already in progress/i);
  assert.equal(blocked.reattach, true);
  assert.equal(blocked.jobId, firstBody.jobId);

  const list = await app.request("/api/jobs");
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.liveJobId, firstBody.jobId);

  // Wait for first job so gate releases (avoid leaking into other tests)
  let job = jobs.get(firstBody.jobId)!;
  for (let i = 0; i < 40 && job.status !== "succeeded" && job.status !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    job = jobs.get(firstBody.jobId)!;
  }
  delete process.env.BSL_DRY_RUN;
});

test("runScript streams lines into the job log before exit", async () => {
  const jobs = new JobStore();
  const job = jobs.create({
    engine: "local",
    repository: "isaacy13/GuideAI",
    ref: "main",
    scheme: "GuideAI",
    deployMode: "ota",
  });
  const script = path.join(os.tmpdir(), `bsl-stream-${Date.now()}.sh`);
  fs.writeFileSync(
    script,
    "#!/bin/sh\necho phase-one\nsleep 0.4\necho phase-two\n",
    { mode: 0o755 },
  );
  const running = runScript(job.id, jobs, script, []);
  // Wait until first line is visible while process still running
  let sawLive = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const logs = jobs.get(job.id)?.logs || [];
    if (logs.some((l) => /phase-one/.test(l))) {
      sawLive = true;
      break;
    }
  }
  assert.equal(sawLive, true, "expected phase-one in logs before script exit");
  await running;
  const finalLogs = jobs.get(job.id)?.logs || [];
  assert.ok(finalLogs.some((l) => /phase-two/.test(l)));
  assert.ok(finalLogs.some((l) => /finished OK/.test(l)));
  fs.unlinkSync(script);
});
