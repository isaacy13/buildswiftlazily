import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  assertSafeRepo,
  assertSafeRef,
  type AppConfig,
  type Env,
} from "./config.js";
import {
  detectIosProjects,
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
import { DeployGate, logError, logInfo } from "./security.js";
import { JobStore } from "./jobs.js";
import { runLocalDeploy } from "./localDeploy.js";
import { buildSetupChecklist } from "./setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type AppDeps = {
  env: Env;
  repoConfig: AppConfig;
  jobs?: JobStore;
};

export function createApp(deps: AppDeps) {
  const { env, repoConfig } = deps;
  const jobs = deps.jobs || new JobStore();
  const deployGate = new DeployGate(8_000);
  const app = new Hono();

  app.use("/api/*", cors());
  app.onError((err, c) => {
    logError(`request error: ${err}`);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/api/health", (c) =>
    c.json({
      ...healthPayload(env),
      deployEngine: env.deployEngine,
      platform: process.platform,
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
      engines: ["local", "actions"],
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
      return c.json({ error: String(e) }, 500);
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
      return c.json({ error: String(e) }, 400);
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
          warning: "No GitHub token — cannot scan tree; set scheme manually",
        });
      }
      const paths = await getRepoTreePaths(env, repository, ref);
      const projects = detectIosProjects(paths, repoConfig.discovery.scan_depth);
      const pinned = repoConfig.repos.find((r) => r.repository === repository);
      return c.json({
        projects,
        suggestedScheme: pinned?.scheme || projects[0]?.name || null,
        suggestedPath: pinned?.project_path || projects[0]?.projectPath || ".",
      });
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  app.post("/api/deploy", async (c) => {
    const gate = deployGate.tryAcquire();
    if (!gate.ok) {
      return c.json(
        { error: gate.reason, retryAfterSec: gate.retryAfterSec },
        429,
      );
    }
    try {
      const body = await c.req.json();
      const engine =
        body.engine === "actions" || body.engine === "local"
          ? body.engine
          : env.deployEngine;
      const deployMode = body.deploy_mode || repoConfig.defaults.deploy_mode || "ota";
      logInfo(
        `deploy engine=${engine} repo=${body.repository} ref=${body.ref} scheme=${body.scheme} mode=${deployMode}`,
      );

      if (engine === "actions") {
        const result = await dispatchDeploy(env, {
          repository: body.repository,
          ref: body.ref,
          project_path: body.project_path,
          scheme: body.scheme,
          configuration: body.configuration || repoConfig.defaults.configuration,
          deploy_mode: deployMode === "testflight" ? "testflight" : deployMode,
          title: body.title,
        });
        const job = jobs.create({
          engine: "actions",
          status: "succeeded",
          repository: body.repository,
          ref: body.ref,
          scheme: body.scheme,
          deployMode,
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
        repository: body.repository,
        ref: body.ref,
        scheme: body.scheme,
        deployMode,
      });
      // Fire and forget
      void runLocalDeploy(env, jobs, job.id, {
        repository: body.repository,
        ref: body.ref,
        project_path: body.project_path,
        scheme: body.scheme,
        configuration: body.configuration || repoConfig.defaults.configuration,
        deploy_mode: deployMode,
        title: body.title,
      });
      return c.json({
        engine: "local",
        jobId: job.id,
        message: "Local build started on this Mac — watch progress below.",
      });
    } catch (e) {
      logError(`deploy failed: ${e}`);
      return c.json({ error: String(e) }, 400);
    } finally {
      deployGate.release();
    }
  });

  app.get("/api/jobs", (c) => c.json({ jobs: jobs.list(20) }));
  app.get("/api/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    return c.json(job);
  });

  app.get("/api/deploys", async (c) => {
    try {
      if (!env.githubToken) return c.json({ runs: [], warning: "No GitHub token" });
      const runs = await listRecentWorkflowRuns(env);
      return c.json({ runs });
    } catch (e) {
      return c.json({ error: String(e), runs: [] }, 500);
    }
  });

  app.get("/api/deploys/:id", async (c) => {
    try {
      const run = await getWorkflowRun(env, Number(c.req.param("id")));
      return c.json(run);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
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
      return c.json({ agents: ranked });
    } catch (e) {
      return c.json({ error: String(e), agents: [] }, 500);
    }
  });

  app.get("/api/cursor/agents/:id", async (c) => {
    try {
      const detail = await getCursorAgentDetail(env, c.req.param("id"));
      return c.json(detail);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
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
