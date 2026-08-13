import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import {
  assertSafeAgentId,
  assertSafeConfiguration,
  assertSafeDeployMode,
  assertSafePlatform,
  assertSafeRef,
  assertSafeRelPath,
  assertSafeRepo,
  assertSafeScheme,
  assertSafeTitle,
  type AppConfig,
  type Env,
} from "./config.js";
import {
  detectXcodeProjects,
  dispatchDeploy,
  getRepoTreePaths,
  getWorkflowRun,
  listBranches,
  listPersonalRepos,
  listRecentWorkflowRuns,
} from "./github.js";
import {
  getCursorAgentDetail,
  listCursorAgents,
  scoreGuideAiRelevance,
} from "./cursor.js";
import { healthPayload, listDevices, listOtaArtifacts } from "./local.js";
import {
  apiTokenOk,
  DeployGate,
  extractApiToken,
  logError,
  logInfo,
  publicError,
} from "./security.js";
import { JobStore } from "./jobs.js";
import { requestJobCancel, runLocalDeploy } from "./localDeploy.js";
import { buildSetupChecklist } from "./setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type AppDeps = {
  env: Env;
  repoConfig: AppConfig;
  jobs?: JobStore;
};

const PUBLIC_API = new Set(["/api/health"]);

export function createApp(deps: AppDeps) {
  const { env, repoConfig } = deps;
  const jobs = deps.jobs || new JobStore();
  const deployGate = new DeployGate(8_000);
  const app = new Hono();

  // Same-origin PWA — do not enable open CORS (would allow cross-site deploy CSRF
  // from any page the operator visits while on Tailscale).

  app.use("/api/*", async (c, next) => {
    const pathOnly = c.req.path.split("?")[0];
    if (PUBLIC_API.has(pathOnly)) {
      await next();
      return;
    }
    if (!env.apiToken) {
      if (env.allowInsecureApi) {
        await next();
        return;
      }
      return c.json(
        {
          error:
            "API locked — set BSL_API_TOKEN in .env (or BSL_ALLOW_INSECURE_API=1 for local smoke only)",
        },
        401,
      );
    }
    const provided = extractApiToken((n) => c.req.header(n));
    if (!apiTokenOk(env.apiToken, provided)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.onError((err, c) => {
    logError(`request error: ${err}`);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/api/health", (c) =>
    c.json({
      ...healthPayload(env),
      deployEngine: env.deployEngine,
      platform: process.platform,
      apiAuthRequired: Boolean(env.apiToken) || !env.allowInsecureApi,
    }),
  );

  app.get("/api/setup", async (c) => c.json(await buildSetupChecklist(env)));

  app.get("/api/config", (c) =>
    c.json({
      defaults: {
        ...repoConfig.defaults,
        deploy_engine: env.deployEngine,
      },
      pinnedRepos: repoConfig.repos,
      guideAiRepo:
        env.guideAiRepo ||
        repoConfig.repos.find((r) => r.id === "guideai")?.repository,
      tsHost: env.tsHost || null,
      toolingRepo: env.toolingRepo,
      deployEngine: env.deployEngine,
      modes: ["ota", "direct", "both", "testflight"],
      platforms: ["ios", "watchos"],
      engines: ["local", "actions"],
      apiAuthRequired: Boolean(env.apiToken) || !env.allowInsecureApi,
    }),
  );

  app.get("/api/repos", async (c) => {
    try {
      const remote = env.githubToken
        ? await listPersonalRepos(env, repoConfig.discovery.max_repos)
        : [];
      const pinned = repoConfig.repos
        .filter((r) => !/^YOUR_/i.test(r.repository) && !r.repository.includes("YOUR_"))
        .map((r) => ({
          id: r.id,
          full_name: r.repository,
          name: r.display_name || r.repository.split("/")[1],
          favorite: Boolean(r.favorite) || r.id === repoConfig.defaults.favorite,
          project_path: r.project_path,
          scheme: r.scheme,
          platform: r.platform || "ios",
          pinned: true,
        }));

      const favoriteSlug = (
        env.guideAiRepo ||
        repoConfig.repos.find((r) => r.id === "guideai")?.repository ||
        ""
      ).toLowerCase();

      const merged = [
        ...pinned,
        ...remote
          .filter((r) => !pinned.some((p) => p.full_name === r.full_name))
          .map((r) => ({
            id: r.full_name,
            full_name: r.full_name,
            name: r.name,
            description: r.description,
            updated_at: r.updated_at,
            default_branch: r.default_branch,
            favorite:
              r.full_name.toLowerCase() === favoriteSlug ||
              r.name.toLowerCase() === "guideai",
            pinned: false,
          })),
      ];

      merged.sort((a, b) => Number(b.favorite) - Number(a.favorite));
      return c.json({
        repos: merged,
        warning: env.githubToken
          ? null
          : "GITHUB_TOKEN not set — showing pinned repos only. Add a token in .env.",
      });
    } catch (e) {
      logError(`repos list failed: ${e}`);
      return c.json({ error: publicError(e) }, 500);
    }
  });

  app.get("/api/repos/:owner/:name/branches", async (c) => {
    try {
      if (!env.githubToken) {
        return c.json({
          branches: [{ name: "main", protected: false }],
          warning: "No GitHub token — defaulting to main",
        });
      }
      const repository = assertSafeRepo(
        `${c.req.param("owner")}/${c.req.param("name")}`,
      );
      const branches = await listBranches(env, repository);
      return c.json({ branches });
    } catch (e) {
      return c.json({ error: publicError(e) }, 400);
    }
  });

  app.get("/api/repos/:owner/:name/ios", async (c) => {
    try {
      const repository = assertSafeRepo(
        `${c.req.param("owner")}/${c.req.param("name")}`,
      );
      const ref = assertSafeRef(c.req.query("ref") || "main");
      if (!env.githubToken) {
        const pinned = repoConfig.repos.find((r) => r.repository === repository);
        return c.json({
          projects: [],
          suggestedScheme: pinned?.scheme || repository.split("/")[1],
          suggestedPath: pinned?.project_path || ".",
          suggestedPlatform: pinned?.platform || "ios",
          warning: "No GitHub token — cannot scan tree; set scheme manually",
        });
      }
      const paths = await getRepoTreePaths(env, repository, ref);
      const projects = detectXcodeProjects(paths, repoConfig.discovery.scan_depth);
      const pinned = repoConfig.repos.find((r) => r.repository === repository);
      const suggestedPlatform =
        pinned?.platform ||
        projects.find((p) => p.platforms.includes("watchos") && !p.platforms.includes("ios"))
          ?.platforms[0] ||
        projects.find((p) => p.platforms[0] === "watchos")?.platforms[0] ||
        "ios";
      return c.json({
        projects,
        suggestedScheme: pinned?.scheme || projects[0]?.name || null,
        suggestedPath: pinned?.project_path || projects[0]?.projectPath || ".",
        suggestedPlatform,
      });
    } catch (e) {
      return c.json({ error: publicError(e) }, 400);
    }
  });

  app.post("/api/deploy", async (c) => {
    const gate = deployGate.tryAcquire(() => jobs.findLive()?.id);
    if (!gate.ok) {
      const live = jobs.findLive();
      const jobId = gate.jobId || live?.id;
      logInfo(
        `deploy blocked: ${gate.reason}${jobId ? ` (reattach job=${jobId.slice(0, 8)} status=${live?.status || jobs.get(jobId)?.status || "?"})` : " (no live job id)"}`,
      );
      return c.json(
        {
          error: gate.reason,
          retryAfterSec: gate.retryAfterSec,
          jobId: jobId || null,
          reattach: Boolean(jobId),
          liveJob: live || (jobId ? jobs.get(jobId) : null) || null,
        },
        429,
      );
    }
    let holdGate = false;
    try {
      const body = await c.req.json();
      const repository = assertSafeRepo(String(body.repository || ""));
      const ref = assertSafeRef(String(body.ref || ""));
      const scheme = assertSafeScheme(String(body.scheme || ""));
      const project_path = assertSafeRelPath(String(body.project_path || "."));
      const configuration = assertSafeConfiguration(
        String(body.configuration || repoConfig.defaults.configuration || "Release"),
      );
      const deployMode = assertSafeDeployMode(
        String(body.deploy_mode || repoConfig.defaults.deploy_mode || "ota"),
      );
      const title = assertSafeTitle(String(body.title || scheme));
      const platform = assertSafePlatform(
        String(
          body.platform ||
            repoConfig.repos.find((r) => r.repository === repository)?.platform ||
            "ios",
        ),
      );
      const engine =
        body.engine === "actions" || body.engine === "local"
          ? body.engine
          : env.deployEngine;

      logInfo(
        `deploy engine=${engine} repo=${repository} ref=${ref} scheme=${scheme} mode=${deployMode} platform=${platform}`,
      );

      if (engine === "actions") {
        const result = await dispatchDeploy(env, {
          repository,
          ref,
          project_path,
          scheme,
          configuration,
          deploy_mode: deployMode === "testflight" ? "testflight" : deployMode,
          platform,
          title,
        });
        const job = jobs.create({
          engine: "actions",
          status: "succeeded",
          repository,
          ref,
          scheme,
          deployMode,
          platform,
          actionsRunUrl: `https://github.com/${env.toolingRepo}/actions`,
        });
        jobs.appendLog(job.id, result.message);
        return c.json({
          engine: "actions",
          jobId: job.id,
          message: result.message + " — open Status for Actions runs / install artifacts.",
        });
      }

      // Local engine (default) — works when Actions runner is down
      const job = jobs.create({
        engine: "local",
        status: "queued",
        repository,
        ref,
        scheme,
        deployMode,
        platform,
      });
      // Hold the gate until the async local job finishes (single-flight).
      holdGate = true;
      deployGate.bindJob(job.id);
      logInfo(
        `deploy queued job=${job.id.slice(0, 8)} — watch Terminal for phase/heartbeat lines (archive + TestFlight can be quiet for a long time)`,
      );
      void runLocalDeploy(env, jobs, job.id, {
        repository,
        ref,
        project_path,
        scheme,
        configuration,
        deploy_mode: deployMode,
        platform,
        title,
      }).finally(() => {
        const finished = jobs.get(job.id);
        logInfo(
          `deploy gate released job=${job.id.slice(0, 8)} status=${finished?.status || "?"}`,
        );
        deployGate.releaseIfJob(job.id);
      });
      return c.json({
        engine: "local",
        jobId: job.id,
        message: "Local build started on this Mac — watch progress below.",
      });
    } catch (e) {
      logError(`deploy failed: ${e}`);
      return c.json({ error: publicError(e) }, 400);
    } finally {
      if (!holdGate) deployGate.release();
    }
  });

  app.get("/api/jobs", (c) => {
    const live = jobs.findLive();
    return c.json({
      jobs: jobs.list(20),
      liveJobId: live?.id || deployGate.getInflightJobId() || null,
      gateHeld: deployGate.isInflight(),
    });
  });
  app.get("/api/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    return c.json(job);
  });

  app.post("/api/jobs/:id/cancel", (c) => {
    const id = c.req.param("id");
    const job = jobs.get(id);
    if (!job) return c.json({ error: "job not found" }, 404);
    if (job.status !== "queued" && job.status !== "running") {
      return c.json({ error: "job is not running", job }, 409);
    }
    requestJobCancel(id);
    jobs.appendLog(id, "Cancel requested — stopping build…");
    // Mark cancelled immediately so refresh/reattach stop treating it as live.
    // runLocalDeploy will also finalize when the child exits.
    jobs.patch(id, {
      status: "cancelled",
      error: "Cancelled",
      finishedAt: new Date().toISOString(),
    });
    deployGate.releaseIfJob(id);
    logInfo(`job ${id.slice(0, 8)} cancel requested`);
    return c.json({ ok: true, job: jobs.get(id) });
  });

  app.get("/api/deploys", async (c) => {
    try {
      if (!env.githubToken) return c.json({ runs: [], warning: "No GitHub token" });
      const runs = await listRecentWorkflowRuns(env);
      return c.json({ runs });
    } catch (e) {
      logError(`deploys list failed: ${e}`);
      return c.json({ error: publicError(e), runs: [] }, 500);
    }
  });

  app.get("/api/deploys/:id", async (c) => {
    try {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: "Invalid run id" }, 400);
      }
      const run = await getWorkflowRun(env, id);
      return c.json(run);
    } catch (e) {
      return c.json({ error: publicError(e) }, 400);
    }
  });

  app.get("/api/devices", async (c) => c.json(await listDevices()));
  app.get("/api/artifacts", (c) => c.json({ artifacts: listOtaArtifacts(env) }));

  app.get("/api/cursor/agents", async (c) => {
    try {
      if (!env.cursorApiKey) {
        return c.json({
          agents: [],
          warning:
            "CURSOR_API_KEY not set — add it in .env to see Cloud Agent threads.",
        });
      }
      const agents = await listCursorAgents(env, 40);
      const guide =
        env.guideAiRepo ||
        repoConfig.repos.find((r) => r.id === "guideai")?.repository ||
        "";
      const ranked = agents
        .map((a) => ({ ...a, relevance: scoreGuideAiRelevance(a, guide) }))
        .sort((a, b) => {
          if (b.relevance !== a.relevance) return b.relevance - a.relevance;
          return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
        });
      // Strip bulky raw payloads from list view
      return c.json({
        agents: ranked.map(({ raw: _raw, ...rest }) => rest),
      });
    } catch (e) {
      logError(`cursor agents failed: ${e}`);
      return c.json({ error: publicError(e), agents: [] }, 500);
    }
  });

  app.get("/api/cursor/agents/:id", async (c) => {
    try {
      const id = assertSafeAgentId(c.req.param("id"));
      const detail = await getCursorAgentDetail(env, id);
      return c.json(detail);
    } catch (e) {
      return c.json({ error: publicError(e) }, 400);
    }
  });

  const otaRoot = path.join(env.artifactRoot, "www");
  fs.mkdirSync(path.join(otaRoot, "ota"), { recursive: true });
  app.use("/ota/*", serveStatic({ root: otaRoot }));

  const webDist = path.resolve(__dirname, "../web/dist");
  if (fs.existsSync(webDist)) {
    app.use(
      "/*",
      serveStatic({
        root: webDist,
        rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p),
      }),
    );
    app.notFound(async (c) => {
      if (c.req.path.startsWith("/api") || c.req.path.startsWith("/ota")) {
        return c.json({ error: "not found" }, 404);
      }
      const index = path.join(webDist, "index.html");
      if (fs.existsSync(index)) return c.html(fs.readFileSync(index, "utf8"));
      return c.text("not found", 404);
    });
  } else {
    app.get("/", (c) =>
      c.html(
        `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:2rem"><h1>buildswiftlazily</h1><p>API up. Run <code>npm run build:web</code>.</p></body>`,
      ),
    );
  }

  return { app, jobs };
}
