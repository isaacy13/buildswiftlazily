import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  loadEnv,
  loadRepoConfig,
  assertSafeRepo,
  assertSafeRef,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
const repoConfig = loadRepoConfig();

const app = new Hono();
app.use("/api/*", cors());

app.get("/api/health", (c) => c.json(healthPayload(env)));

app.get("/api/config", (c) =>
  c.json({
    defaults: repoConfig.defaults,
    pinnedRepos: repoConfig.repos,
    guideAiRepo: env.guideAiRepo || repoConfig.repos.find((r) => r.id === "guideai")?.repository,
    tsHost: env.tsHost || null,
    toolingRepo: env.toolingRepo,
  }),
);

app.get("/api/repos", async (c) => {
  try {
    const remote = env.githubToken
      ? await listPersonalRepos(env, repoConfig.discovery.max_repos)
      : [];
    const pinned = repoConfig.repos.map((r) => ({
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
    return c.json({ repos: merged });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

app.get("/api/repos/:owner/:name/branches", async (c) => {
  try {
    const repository = assertSafeRepo(`${c.req.param("owner")}/${c.req.param("name")}`);
    const branches = await listBranches(env, repository);
    return c.json({ branches });
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }
});

app.get("/api/repos/:owner/:name/ios", async (c) => {
  try {
    const repository = assertSafeRepo(`${c.req.param("owner")}/${c.req.param("name")}`);
    const ref = assertSafeRef(c.req.query("ref") || "main");
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
  try {
    const body = await c.req.json();
    const result = await dispatchDeploy(env, {
      repository: body.repository,
      ref: body.ref,
      project_path: body.project_path,
      scheme: body.scheme,
      configuration: body.configuration || repoConfig.defaults.configuration,
      deploy_mode: body.deploy_mode || repoConfig.defaults.deploy_mode,
      title: body.title,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }
});

app.get("/api/deploys", async (c) => {
  try {
    const runs = await listRecentWorkflowRuns(env);
    return c.json({ runs });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
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

// Serve OTA files from artifact www (so one Tailscale Serve port is enough)
const otaRoot = path.join(env.artifactRoot, "www");
fs.mkdirSync(path.join(otaRoot, "ota"), { recursive: true });
app.use(
  "/ota/*",
  serveStatic({
    root: otaRoot,
  }),
);

// Static web UI
const webDist = path.resolve(__dirname, "../web/dist");
if (fs.existsSync(webDist)) {
  app.use(
    "/*",
    serveStatic({
      root: webDist,
      rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p),
    }),
  );
  // SPA fallback for client routes (none yet, but keeps PWA refresh safe)
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
      `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:2rem"><h1>buildswiftlazily</h1><p>API is up. Build the web UI: <code>npm run build:web</code></p><p><a href="/api/health">/api/health</a></p></body>`,
    ),
  );
}

serve({ fetch: app.fetch, port: env.controlPort, hostname: "127.0.0.1" }, () => {
  console.log(
    `buildswiftlazily listening on http://127.0.0.1:${env.controlPort} (Tailscale Serve this port)`,
  );
});

export type { Env };
